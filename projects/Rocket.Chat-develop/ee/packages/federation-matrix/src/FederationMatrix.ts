import { type IFederationMatrixService, ServiceClass } from '@rocket.chat/core-services';
import {
	isDeletedMessage,
	isMessageFromMatrixFederation,
	isQuoteAttachment,
	isRoomNativeFederated,
	isUserNativeFederated,
	UserStatus,
} from '@rocket.chat/core-typings';
import type { MessageQuoteAttachment, IMessage, IRoom, IUser, IRoomNativeFederated } from '@rocket.chat/core-typings';
import { eventIdSchema, getAllServices, roomIdSchema, userIdSchema } from '@rocket.chat/federation-sdk';
import type { EventID, UserID, HomeserverServices, FileMessageType, PresenceState, PduForType } from '@rocket.chat/federation-sdk';
import { Logger } from '@rocket.chat/logger';
import { Users, Subscriptions, Messages, Rooms, Settings } from '@rocket.chat/models';
import emojione from 'emojione';

import { acceptInvite } from './api/_matrix/invite';
import { toExternalMessageFormat, toExternalQuoteMessageFormat } from './helpers/message.parsers';
import { MatrixMediaService } from './services/MatrixMediaService';

export const fileTypes: Record<string, FileMessageType> = {
	image: 'm.image',
	video: 'm.video',
	audio: 'm.audio',
	file: 'm.file',
};

/** helper to validate the username format */
export function validateFederatedUsername(mxid: string): mxid is UserID {
	if (!mxid.startsWith('@')) return false;

	const parts = mxid.substring(1).split(':');
	if (parts.length < 2) return false;

	const localpart = parts[0];
	const domainAndPort = parts.slice(1).join(':');

	const localpartRegex = /^(?:[a-z0-9._\-]|=[0-9a-fA-F]{2}){1,255}$/;
	if (!localpartRegex.test(localpart)) return false;

	const [domain, port] = domainAndPort.split(':');

	const hostnameRegex = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)*$/i;
	const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;
	const ipv6Regex = /^\[([0-9a-f:.]+)\]$/i;

	if (!(hostnameRegex.test(domain) || ipv4Regex.test(domain) || ipv6Regex.test(domain))) {
		return false;
	}

	if (port !== undefined) {
		const portNum = Number(port);
		if (!/^[0-9]+$/.test(port) || portNum < 1 || portNum > 65535) {
			return false;
		}
	}

	return true;
}
export const extractDomainFromMatrixUserId = (mxid: string): string => {
	const separatorIndex = mxid.indexOf(':', 1);
	if (separatorIndex === -1) {
		throw new Error(`Invalid federated username: ${mxid}`);
	}
	return mxid.substring(separatorIndex + 1);
};

/**
 * Extract the username and the servername from a matrix user id
 * if the serverName is the same as the serverName in the mxid, return only the username (rocket.chat regular username)
 * otherwise, return the full mxid and the servername
 */
export const getUsernameServername = (mxid: string, serverName: string): [mxid: string, serverName: string, isLocal: boolean] => {
	const senderServerName = extractDomainFromMatrixUserId(mxid);
	// if the serverName is the same as the serverName in the mxid, return only the username (rocket.chat regular username)
	if (serverName === senderServerName) {
		const separatorIndex = mxid.indexOf(':', 1);
		if (separatorIndex === -1) {
			throw new Error(`Invalid federated username: ${mxid}`);
		}
		return [mxid.substring(1, separatorIndex), senderServerName, true]; // removers also the @
	}

	return [mxid, senderServerName, false];
};
/**
 * Helper function to create a federated user
 *
 * Because of historical reasons, we can have users only with federated flag but no federation object
 * So we need to upsert the user with the federation object
 */
export async function createOrUpdateFederatedUser(options: { username: UserID; name?: string; origin: string }): Promise<string> {
	const { username, name = username, origin } = options;

	const result = await Users.updateOne(
		{
			username,
		},
		{
			$set: {
				username,
				name: name || username,
				type: 'user' as const,
				status: UserStatus.OFFLINE,
				active: true,
				roles: ['user'],
				requirePasswordChange: false,
				federated: true,
				federation: {
					version: 1,
					mui: username,
					origin,
				},
				_updatedAt: new Date(),
			},
			$setOnInsert: {
				createdAt: new Date(),
			},
		},
		{
			upsert: true,
		},
	);

	const userId = result.upsertedId || (await Users.findOneByUsername(username, { projection: { _id: 1 } }))?._id;
	if (!userId) {
		throw new Error(`Failed to create or update federated user: ${username}`);
	}
	if (typeof userId !== 'string') {
		return userId.toString();
	}
	return userId;
}

export { generateEd25519RandomSecretKey } from '@rocket.chat/federation-sdk';

export class FederationMatrix extends ServiceClass implements IFederationMatrixService {
	protected name = 'federation-matrix';

	private serverName: string;

	private processEDUTyping: boolean;

	private processEDUPresence: boolean;

	private homeserverServices: HomeserverServices;

	private readonly logger = new Logger(this.name);

	async created(): Promise<void> {
		// although this is async function, it is not awaited, so we need to register the listeners before everything else
		this.onEvent('watch.settings', async ({ clientAction, setting }): Promise<void> => {
			if (clientAction === 'removed') {
				return;
			}

			const { _id, value } = setting;
			if (_id === 'Federation_Service_Domain' && typeof value === 'string') {
				this.serverName = value;
			} else if (_id === 'Federation_Service_EDU_Process_Typing' && typeof value === 'boolean') {
				this.processEDUTyping = value;
			} else if (_id === 'Federation_Service_EDU_Process_Presence' && typeof value === 'boolean') {
				this.processEDUPresence = value;
			}
		});

		this.onEvent(
			'presence.status',
			async ({ user }: { user: Pick<IUser, '_id' | 'username' | 'status' | 'statusText' | 'name' | 'roles'> }): Promise<void> => {
				if (!this.processEDUPresence) {
					return;
				}

				if (!user.username || !user.status || user.username.includes(':')) {
					return;
				}
				const localUser = await Users.findOneByUsername(user.username, { projection: { _id: 1, federated: 1, federation: 1 } });
				if (!localUser) {
					return;
				}

				if (!isUserNativeFederated(localUser)) {
					return;
				}

				// TODO: Check if it should exclude himself from the list
				const roomsUserIsMemberOf = await Subscriptions.findUserFederatedRoomIds(localUser._id).toArray();
				const statusMap: Record<UserStatus, PresenceState> = {
					[UserStatus.ONLINE]: 'online',
					[UserStatus.OFFLINE]: 'offline',
					[UserStatus.AWAY]: 'unavailable',
					[UserStatus.BUSY]: 'unavailable',
					[UserStatus.DISABLED]: 'offline',
				};
				void this.homeserverServices.edu.sendPresenceUpdateToRooms(
					[
						{
							user_id: localUser.federation.mui,
							presence: statusMap[user.status] || 'offline',
						},
					],
					roomsUserIsMemberOf.map(({ externalRoomId }) => externalRoomId).filter(Boolean),
				);
			},
		);

		this.serverName = (await Settings.getValueById<string>('Federation_Service_Domain')) || '';
		this.processEDUTyping = (await Settings.getValueById<boolean>('Federation_Service_EDU_Process_Typing')) || false;
		this.processEDUPresence = (await Settings.getValueById<boolean>('Federation_Service_EDU_Process_Presence')) || false;

		try {
			this.homeserverServices = getAllServices();

			MatrixMediaService.setHomeserverServices(this.homeserverServices);
		} catch (err) {
			this.logger.warn({ msg: 'Homeserver module not available, running in limited mode', err });
		}
	}

	async createRoom(room: IRoom, owner: IUser, members: string[]): Promise<{ room_id: string; event_id: string }> {
		if (!this.homeserverServices) {
			this.logger.warn('Homeserver services not available, skipping room creation');
			throw new Error('Homeserver services not available');
		}

		if (room.t !== 'c' && room.t !== 'p') {
			throw new Error('Room is not a public or private room');
		}

		try {
			const matrixUserId = userIdSchema.parse(`@${owner.username}:${this.serverName}`);
			const roomName = room.name || room.fname || 'Untitled Room';

			// canonical alias computed from name
			const matrixRoomResult = await this.homeserverServices.room.createRoom(matrixUserId, roomName, room.t === 'c' ? 'public' : 'invite');

			this.logger.debug('Matrix room created:', matrixRoomResult);

			await Rooms.setAsFederated(room._id, { mrid: matrixRoomResult.room_id, origin: this.serverName });

			const federatedRoom = await Rooms.findOneById(room._id);

			if (federatedRoom && isRoomNativeFederated(federatedRoom)) {
				await this.inviteUsersToRoom(
					federatedRoom,
					members.filter((m) => m !== owner.username),
					owner,
				);
			}

			this.logger.debug('Room creation completed successfully', room._id);

			return matrixRoomResult;
		} catch (error) {
			this.logger.error('Failed to create room:', error);
			throw error;
		}
	}

	async ensureFederatedUsersExistLocally(usernames: string[]): Promise<void> {
		try {
			this.logger.debug('Ensuring federated users exist locally before DM creation', { memberCount: usernames.length });

			const federatedUsers = usernames.filter(validateFederatedUsername);
			for await (const username of federatedUsers) {
				const existingUser = await Users.findOneByUsername(username);
				if (existingUser && isUserNativeFederated(existingUser)) {
					continue;
				}

				await createOrUpdateFederatedUser({
					username,
					name: username,
					origin: extractDomainFromMatrixUserId(username),
				});
			}
		} catch (error) {
			this.logger.error({ msg: 'Failed to ensure federated users exist locally', error });
			throw error;
		}
	}

	async createDirectMessageRoom(room: IRoom, members: IUser[], creatorId: IUser['_id']): Promise<void> {
		try {
			this.logger.debug('Creating direct message room in Matrix', { roomId: room._id, memberCount: members.length });

			if (!this.homeserverServices) {
				this.logger.warn('Homeserver services not available, skipping DM room creation');
				return;
			}

			const creator = await Users.findOneById(creatorId);
			if (!creator) {
				throw new Error('Creator not found in members list');
			}

			const actualMatrixUserId = `@${creator.username}:${this.serverName}`;

			let matrixRoomResult: { room_id: string; event_id?: string };
			if (members.length === 2) {
				const otherMember = members.find((member) => member._id !== creatorId);
				if (!otherMember) {
					throw new Error('Other member not found for 1-on-1 DM');
				}
				if (!isUserNativeFederated(otherMember)) {
					throw new Error('Other member is not federated');
				}
				const roomId = await this.homeserverServices.room.createDirectMessageRoom(
					userIdSchema.parse(actualMatrixUserId),
					userIdSchema.parse(otherMember.username),
				);
				matrixRoomResult = { room_id: roomId };
			} else {
				// For group DMs (more than 2 members), create a private room
				const roomName = room.name || room.fname || `Group chat with ${members.length} members`;
				matrixRoomResult = await this.homeserverServices.room.createRoom(userIdSchema.parse(actualMatrixUserId), roomName, 'invite');

				for await (const member of members) {
					if (member._id === creatorId) {
						continue;
					}

					if (!isUserNativeFederated(member)) {
						continue;
					}

					try {
						await this.homeserverServices.invite.inviteUserToRoom(
							userIdSchema.parse(member.username),
							roomIdSchema.parse(matrixRoomResult.room_id),
							userIdSchema.parse(actualMatrixUserId),
						);
					} catch (error) {
						this.logger.error('Error creating or updating bridged user for DM:', error);
					}
				}
			}

			await Rooms.setAsFederated(room._id, {
				mrid: matrixRoomResult.room_id,
				origin: this.serverName,
			});
			this.logger.debug('Direct message room creation completed successfully', room._id);
		} catch (error) {
			this.logger.error('Failed to create direct message room:', error);
			throw error;
		}
	}

	private getMatrixMessageType(mimeType?: string): FileMessageType {
		const mainType = mimeType?.split('/')[0];
		if (!mainType) {
			return fileTypes.file;
		}

		return fileTypes[mainType] ?? fileTypes.file;
	}

	private async handleFileMessage(
		message: IMessage,
		matrixRoomId: string,
		matrixUserId: string,
		matrixDomain: string,
	): Promise<{ eventId: string } | null> {
		if (!message.files || message.files.length === 0) {
			return null;
		}

		const replyToMessage = await this.handleThreadedMessage(message, matrixRoomId, matrixUserId, matrixDomain);
		const quoteMessage = await this.handleQuoteMessage(message, matrixRoomId, matrixUserId, matrixDomain);
		try {
			let lastEventId: { eventId: string } | null = null;

			// TODO handle multiple files, we currently save thumbs on files[], we need to flag them as thumb so we can ignore them here
			const [file] = message.files;

			const mxcUri = await MatrixMediaService.prepareLocalFileForMatrix(file._id, matrixDomain, matrixRoomId);

			const msgtype = this.getMatrixMessageType(file.type);
			const fileContent = {
				body: file.name,
				msgtype,
				url: mxcUri,
				info: {
					mimetype: file.type,
					size: file.size,
				},
			};

			lastEventId = await this.homeserverServices.message.sendFileMessage(
				roomIdSchema.parse(matrixRoomId),
				fileContent,
				userIdSchema.parse(matrixUserId),
				replyToMessage || quoteMessage,
			);

			return lastEventId;
		} catch (error) {
			this.logger.error('Failed to handle file message', {
				messageId: message._id,
				error,
			});
			throw error;
		}
	}

	private async handleTextMessage(
		message: IMessage,
		matrixRoomId: string,
		matrixUserId: string,
		matrixDomain: string,
	): Promise<{ eventId: string } | null> {
		const parsedMessage = await toExternalMessageFormat({
			message: message.msg,
			externalRoomId: matrixRoomId,
			homeServerDomain: matrixDomain,
		});

		const replyToMessage = await this.handleThreadedMessage(message, matrixRoomId, matrixUserId, matrixDomain);
		const quoteMessage = await this.handleQuoteMessage(message, matrixRoomId, matrixUserId, matrixDomain);

		return this.homeserverServices.message.sendMessage(
			roomIdSchema.parse(matrixRoomId),
			message.msg,
			parsedMessage,
			userIdSchema.parse(matrixUserId),
			replyToMessage || quoteMessage,
		);
	}

	private async handleThreadedMessage(message: IMessage, matrixRoomId: string, matrixUserId: string, matrixDomain: string) {
		if (!message.tmid) {
			return;
		}

		const threadRootMessage = await Messages.findOneById(message.tmid);
		const threadRootEventId = threadRootMessage?.federation?.eventId;

		if (!threadRootEventId) {
			throw new Error('Thread root event ID not found');
		}

		const quoteMessageEventId = message.attachments?.some((attachment) => isQuoteAttachment(attachment) && Boolean(attachment.message_link))
			? (await this.getQuoteMessage(message, matrixRoomId, matrixUserId, matrixDomain))?.eventToReplyTo
			: undefined;

		const latestThreadMessage = !quoteMessageEventId
			? (await Messages.findLatestFederationThreadMessageByTmid(message.tmid, message._id))?.federation?.eventId ||
				eventIdSchema.parse(threadRootEventId)
			: undefined;

		if (!quoteMessageEventId && !latestThreadMessage) {
			throw new Error('No event to reply to found');
		}

		const eventToReplyToNormalized = eventIdSchema.parse(quoteMessageEventId ?? latestThreadMessage);

		if (quoteMessageEventId) {
			return { threadEventId: eventIdSchema.parse(threadRootEventId), replyToEventId: eventToReplyToNormalized };
		}
		return { threadEventId: eventIdSchema.parse(threadRootEventId), latestThreadEventId: eventToReplyToNormalized };
	}

	private async handleQuoteMessage(message: IMessage, matrixRoomId: string, matrixUserId: string, matrixDomain: string) {
		if (!message.attachments?.some((attachment) => isQuoteAttachment(attachment) && Boolean(attachment.message_link))) {
			return;
		}
		const quoteMessage = await this.getQuoteMessage(message, matrixRoomId, matrixUserId, matrixDomain);
		if (!quoteMessage) {
			throw new Error('Failed to retrieve quote message');
		}
		return {
			replyToEventId: eventIdSchema.parse(quoteMessage.eventToReplyTo),
		};
	}

	async sendMessage(message: IMessage, room: IRoomNativeFederated, user: IUser): Promise<void> {
		try {
			if (!this.homeserverServices) {
				this.logger.warn('Homeserver services not available, skipping message send');
				return;
			}

			const userMui = isUserNativeFederated(user) ? user.federation.mui : `@${user.username}:${this.serverName}`;

			let result;
			if (message.files && message.files.length > 0) {
				result = await this.handleFileMessage(message, room.federation.mrid, userMui, this.serverName);
			} else {
				result = await this.handleTextMessage(message, room.federation.mrid, userMui, this.serverName);
			}

			if (!result) {
				throw new Error('Failed to send message to Matrix - no result returned');
			}

			await Messages.setFederationEventIdById(message._id, result.eventId);

			this.logger.debug('Message sent to Matrix successfully:', result.eventId);
		} catch (error) {
			this.logger.error('Failed to send message to Matrix:', error);
			throw error;
		}
	}

	private async getQuoteMessage(
		message: IMessage,
		matrixRoomId: string,
		matrixUserId: string,
		matrixDomain: string,
	): Promise<{ formattedMessage: string; rawMessage: string; eventToReplyTo: string } | undefined> {
		if (!message.attachments) {
			return;
		}
		const messageLink = (
			message.attachments.find((attachment) => isQuoteAttachment(attachment) && Boolean(attachment.message_link)) as MessageQuoteAttachment
		).message_link;

		if (!messageLink) {
			return;
		}
		const messageToReplyToId = messageLink.includes('msg=') && messageLink?.split('msg=').pop();
		if (!messageToReplyToId) {
			return;
		}
		const messageToReplyTo = await Messages.findOneById(messageToReplyToId);
		if (!messageToReplyTo?.federation?.eventId) {
			return;
		}

		const { formattedMessage, message: rawMessage } = await toExternalQuoteMessageFormat({
			externalRoomId: matrixRoomId,
			eventToReplyTo: messageToReplyTo.federation?.eventId,
			originalEventSender: matrixUserId,
			message: message.msg,
			homeServerDomain: matrixDomain,
		});

		return {
			formattedMessage,
			rawMessage,
			eventToReplyTo: messageToReplyTo.federation.eventId,
		};
	}

	async deleteMessage(matrixRoomId: string, message: IMessage): Promise<void> {
		try {
			if (!isMessageFromMatrixFederation(message) || isDeletedMessage(message)) {
				return;
			}

			if (!this.homeserverServices) {
				this.logger.warn('Homeserver services not available, skipping message redaction');
				return;
			}

			const matrixEventId = message.federation?.eventId;
			if (!matrixEventId) {
				throw new Error(`No Matrix event ID mapping found for message ${message._id}`);
			}

			// TODO fix branded EventID and remove type casting
			// TODO message.u?.username is not the user who removed the message
			const eventId = await this.homeserverServices.message.redactMessage(
				roomIdSchema.parse(matrixRoomId),
				eventIdSchema.parse(matrixEventId),
			);

			this.logger.debug('Message Redaction sent to Matrix successfully:', eventId);
		} catch (error) {
			this.logger.error('Failed to send redaction to Matrix:', error);
			throw error;
		}
	}

	async inviteUsersToRoom(room: IRoomNativeFederated, matrixUsersUsername: string[], inviter: IUser): Promise<void> {
		try {
			const inviterUserId = `@${inviter.username}:${this.serverName}`;

			await Promise.all(
				matrixUsersUsername.map(async (username) => {
					if (validateFederatedUsername(username)) {
						return this.homeserverServices.invite.inviteUserToRoom(
							userIdSchema.parse(username),
							roomIdSchema.parse(room.federation.mrid),
							userIdSchema.parse(inviterUserId),
						);
					}

					// if inviter is an external user it means we receive the invite from the endpoint
					// since we accept from there we can skip accepting here
					if (isUserNativeFederated(inviter)) {
						this.logger.debug('Inviter is native federated, skip accept invite');
						return;
					}

					const result = await this.homeserverServices.invite.inviteUserToRoom(
						userIdSchema.parse(`@${username}:${this.serverName}`),
						roomIdSchema.parse(room.federation.mrid),
						userIdSchema.parse(inviterUserId),
					);

					return acceptInvite(result.event, username, this.homeserverServices);
				}),
			);
		} catch (error) {
			this.logger.error({ msg: 'Failed to invite an user to Matrix:', err: error });
			throw error;
		}
	}

	async sendReaction(messageId: string, reaction: string, user: IUser): Promise<void> {
		try {
			const message = await Messages.findOneById(messageId);
			if (!message) {
				throw new Error(`Message ${messageId} not found`);
			}

			const room = await Rooms.findOneById(message.rid);
			if (!room || !isRoomNativeFederated(room)) {
				throw new Error(`No Matrix room mapping found for room ${message.rid}`);
			}

			const matrixEventId = message.federation?.eventId;
			if (!matrixEventId) {
				throw new Error(`No Matrix event ID mapping found for message ${messageId}`);
			}

			const reactionKey = emojione.shortnameToUnicode(reaction);

			const userMui = isUserNativeFederated(user) ? user.federation.mui : `@${user.username}:${this.serverName}`;

			const eventId = await this.homeserverServices.message.sendReaction(
				roomIdSchema.parse(room.federation.mrid),
				eventIdSchema.parse(matrixEventId),
				reactionKey,
				userIdSchema.parse(userMui),
			);

			await Messages.setFederationReactionEventId(user.username || '', messageId, reaction, eventId);

			this.logger.debug('Reaction sent to Matrix successfully:', eventId);
		} catch (error) {
			this.logger.error('Failed to send reaction to Matrix:', error);
			throw error;
		}
	}

	async removeReaction(messageId: string, reaction: string, user: IUser, oldMessage: IMessage): Promise<void> {
		try {
			const message = await Messages.findOneById(messageId);
			if (!message) {
				this.logger.error(`Message ${messageId} not found`);
				return;
			}

			const targetEventId = message.federation?.eventId;
			if (!targetEventId) {
				this.logger.warn(`No federation event ID found for message ${messageId}`);
				return;
			}

			const room = await Rooms.findOneById(message.rid);
			if (!room || !isRoomNativeFederated(room)) {
				this.logger.error(`No Matrix room mapping found for room ${message.rid}`);
				return;
			}

			const reactionKey = emojione.shortnameToUnicode(reaction);

			const userMui = isUserNativeFederated(user) ? user.federation.mui : `@${user.username}:${this.serverName}`;

			const reactionData = oldMessage.reactions?.[reaction];
			if (!reactionData?.federationReactionEventIds) {
				return;
			}

			for await (const [eventId, username] of Object.entries(reactionData.federationReactionEventIds)) {
				if (username !== user.username) {
					continue;
				}

				const redactionEventId = await this.homeserverServices.message.unsetReaction(
					roomIdSchema.parse(room.federation.mrid),
					eventIdSchema.parse(eventId),
					reactionKey,
					userIdSchema.parse(userMui),
				);
				if (!redactionEventId) {
					this.logger.warn('No reaction event found to remove in Matrix');
					return;
				}

				await Messages.unsetFederationReactionEventId(eventId, messageId, reaction);
				break;
			}
		} catch (error) {
			this.logger.error('Failed to remove reaction from Matrix:', error);
			throw error;
		}
	}

	async getEventById(eventId: EventID) {
		return this.homeserverServices.event.getEventById(eventId);
	}

	async leaveRoom(roomId: string, user: IUser, kicker?: IUser): Promise<void> {
		if (kicker && isUserNativeFederated(kicker)) {
			this.logger.debug('Only local users can remove others, ignoring action');
			return;
		}

		try {
			const room = await Rooms.findOneById(roomId);
			if (!room || !isRoomNativeFederated(room)) {
				this.logger.debug(`Room ${roomId} is not federated, skipping leave operation`);
				return;
			}

			if (!this.homeserverServices) {
				this.logger.warn('Homeserver services not available, skipping room leave');
				return;
			}

			const actualMatrixUserId = isUserNativeFederated(user) ? user.federation.mui : `@${user.username}:${this.serverName}`;

			await this.homeserverServices.room.leaveRoom(roomIdSchema.parse(room.federation.mrid), userIdSchema.parse(actualMatrixUserId));

			this.logger.info(`User ${user.username} left Matrix room ${room.federation.mrid} successfully`);
		} catch (error) {
			this.logger.error('Failed to leave room in Matrix:', error);
			throw error;
		}
	}

	async kickUser(room: IRoomNativeFederated, removedUser: IUser, userWhoRemoved: IUser): Promise<void> {
		if (!this.homeserverServices) {
			this.logger.warn('Homeserver services not available, skipping user kick');
			return;
		}

		try {
			const actualKickedMatrixUserId = isUserNativeFederated(removedUser)
				? removedUser.federation.mui
				: `@${removedUser.username}:${this.serverName}`;

			const actualSenderMatrixUserId = isUserNativeFederated(userWhoRemoved)
				? userWhoRemoved.federation.mui
				: `@${userWhoRemoved.username}:${this.serverName}`;

			await this.homeserverServices.room.kickUser(
				roomIdSchema.parse(room.federation.mrid),
				userIdSchema.parse(actualKickedMatrixUserId),
				userIdSchema.parse(actualSenderMatrixUserId),
				`Kicked by ${userWhoRemoved.username}`,
			);

			this.logger.info(`User ${removedUser.username} was kicked from Matrix room ${room.federation.mrid} by ${userWhoRemoved.username}`);
		} catch (error) {
			this.logger.error('Failed to kick user from Matrix room:', error);
			throw error;
		}
	}

	async updateMessage(room: IRoomNativeFederated, message: IMessage): Promise<void> {
		try {
			const matrixEventId = message.federation?.eventId;
			if (!matrixEventId) {
				throw new Error(`No Matrix event ID mapping found for message ${message._id}`);
			}

			const user = await Users.findOneById(message.u._id, { projection: { _id: 1, username: 1, federation: 1, federated: 1 } });
			if (!user) {
				this.logger.error(`No user found for ID ${message.u._id}`);
				return;
			}

			const userMui = isUserNativeFederated(user) ? user.federation.mui : `@${user.username}:${this.serverName}`;

			const parsedMessage = await toExternalMessageFormat({
				message: message.msg,
				externalRoomId: room.federation.mrid,
				homeServerDomain: this.serverName,
			});
			const eventId = await this.homeserverServices.message.updateMessage(
				roomIdSchema.parse(room.federation.mrid),
				message.msg,
				parsedMessage,
				userIdSchema.parse(userMui),
				eventIdSchema.parse(matrixEventId),
			);

			this.logger.debug('Message updated in Matrix successfully:', eventId);
		} catch (error) {
			this.logger.error('Failed to update message in Matrix:', error);
			throw error;
		}
	}

	async updateRoomName(rid: string, displayName: string, user: IUser): Promise<void> {
		if (!this.homeserverServices) {
			this.logger.warn('Homeserver services not available, skipping room name update');
			return;
		}

		const room = await Rooms.findOneById(rid);
		if (!room || !isRoomNativeFederated(room)) {
			throw new Error(`No Matrix room mapping found for room ${rid}`);
		}

		if (isUserNativeFederated(user)) {
			this.logger.debug('Only local users can change the name of a room, ignoring action');
			return;
		}

		const userMui = `@${user.username}:${this.serverName}`;

		await this.homeserverServices.room.updateRoomName(roomIdSchema.parse(room.federation.mrid), displayName, userIdSchema.parse(userMui));
	}

	async updateRoomTopic(
		room: IRoomNativeFederated,
		topic: string,
		user: Pick<IUser, '_id' | 'username' | 'federation' | 'federated'>,
	): Promise<void> {
		if (!this.homeserverServices) {
			this.logger.warn('Homeserver services not available, skipping room topic update');

			return;
		}

		if (isUserNativeFederated(user)) {
			this.logger.debug('Only local users can change the topic of a room, ignoring action');
			return;
		}

		const userMui = `@${user.username}:${this.serverName}`;

		await this.homeserverServices.room.setRoomTopic(roomIdSchema.parse(room.federation.mrid), userIdSchema.parse(userMui), topic);
	}

	async addUserRoleRoomScoped(
		room: IRoomNativeFederated,
		senderId: string,
		userId: string,
		role: 'moderator' | 'owner' | 'leader' | 'user',
	): Promise<void> {
		if (!this.homeserverServices) {
			this.logger.warn('Homeserver services not available, skipping user role room scoped');
			return;
		}

		if (role === 'leader') {
			throw new Error('Leader role is not supported');
		}

		const userSender = await Users.findOneById(senderId);
		if (!userSender) {
			throw new Error(`No user found for ID ${senderId}`);
		}

		if (isUserNativeFederated(userSender)) {
			this.logger.debug('Only local users can change roles of other users in a room, ignoring action');
			return;
		}

		const senderMui = `@${userSender.username}:${this.serverName}`;

		const user = await Users.findOneById(userId);
		if (!user) {
			throw new Error(`No user found for ID ${userId}`);
		}
		const userMui = isUserNativeFederated(user) ? user.federation.mui : `@${user.username}:${this.serverName}`;

		let powerLevel = 0;
		if (role === 'owner') {
			powerLevel = 100;
		} else if (role === 'moderator') {
			powerLevel = 50;
		}
		await this.homeserverServices.room.setPowerLevelForUser(
			roomIdSchema.parse(room.federation.mrid),
			userIdSchema.parse(senderMui),
			userIdSchema.parse(userMui),
			powerLevel,
		);
	}

	async notifyUserTyping(rid: string, user: string, isTyping: boolean) {
		if (!this.processEDUTyping) {
			return;
		}

		if (!rid || !user) {
			return;
		}
		const room = await Rooms.findOneById(rid);
		if (!room || !isRoomNativeFederated(room)) {
			return;
		}
		const localUser = await Users.findOneByUsername<Pick<IUser, '_id' | 'username' | 'federation' | 'federated'>>(user, {
			projection: { _id: 1, username: 1, federation: 1, federated: 1 },
		});

		if (!localUser) {
			return;
		}

		const userMui = isUserNativeFederated(localUser) ? localUser.federation.mui : `@${localUser.username}:${this.serverName}`;

		void this.homeserverServices.edu.sendTypingNotification(room.federation.mrid, userMui, isTyping);
	}

	async verifyMatrixIds(matrixIds: string[]): Promise<{ [key: string]: string }> {
		const results = Object.fromEntries(
			await Promise.all(
				matrixIds.map(async (matrixId) => {
					// Split only on the first ':' (after the leading '@') so we keep any port in the homeserver
					const separatorIndex = matrixId.indexOf(':', 1);
					if (separatorIndex === -1) {
						return [matrixId, 'UNABLE_TO_VERIFY'];
					}
					const userId = matrixId.slice(0, separatorIndex);
					const homeserverUrl = matrixId.slice(separatorIndex + 1);

					if (homeserverUrl === this.serverName) {
						const user = await Users.findOneByUsername(userId.slice(1));
						return [matrixId, user ? 'VERIFIED' : 'UNVERIFIED'];
					}

					if (!homeserverUrl) {
						return [matrixId, 'UNABLE_TO_VERIFY'];
					}
					try {
						const result = await this.homeserverServices.request.get<
							| {
									avatar_url: string;
									displayname: string;
							  }
							| {
									errcode: string;
									error: string;
							  }
						>(homeserverUrl, `/_matrix/federation/v1/query/profile`, { user_id: matrixId });

						if ('errcode' in result && result.errcode === 'M_NOT_FOUND') {
							return [matrixId, 'UNVERIFIED'];
						}

						return [matrixId, 'VERIFIED'];
					} catch (e) {
						return [matrixId, 'UNABLE_TO_VERIFY'];
					}
				}),
			),
		);

		return results;
	}

	async emitJoin(membershipEvent: PduForType<'m.room.member'>, eventId: EventID) {
		if (!this.homeserverServices) {
			this.logger.warn('Homeserver services not available, skipping user role room scoped');
			return;
		}

		this.homeserverServices.emitter.emit('homeserver.matrix.membership', {
			event_id: eventId,
			event: membershipEvent,
			room_id: membershipEvent.room_id,
			state_key: membershipEvent.state_key,
			content: { membership: 'join' },
			sender: membershipEvent.sender,
			origin_server_ts: Date.now(),
		});
	}
}
