import { FederationMatrix, Message, MeteorService } from '@rocket.chat/core-services';
import type { IUser, IRoom, FileAttachmentProps } from '@rocket.chat/core-typings';
import type { Emitter } from '@rocket.chat/emitter';
import type { FileMessageType, MessageType, FileMessageContent, HomeserverEventSignatures, EventID } from '@rocket.chat/federation-sdk';
import { Logger } from '@rocket.chat/logger';
import { Users, Rooms, Messages } from '@rocket.chat/models';

import { fileTypes } from '../FederationMatrix';
import { toInternalMessageFormat, toInternalQuoteMessageFormat } from '../helpers/message.parsers';
import { MatrixMediaService } from '../services/MatrixMediaService';

const logger = new Logger('federation-matrix:message');

async function getThreadMessageId(threadRootEventId: EventID): Promise<{ tmid: string; tshow: boolean } | undefined> {
	const threadRootMessage = await Messages.findOneByFederationId(threadRootEventId);
	if (!threadRootMessage) {
		logger.warn('Thread root message not found for event:', threadRootEventId);
		return;
	}

	const shouldSetTshow = !threadRootMessage?.tcount;
	return { tmid: threadRootMessage._id, tshow: shouldSetTshow };
}

async function handleMediaMessage(
	url: string,
	fileInfo: FileMessageContent['info'],
	msgtype: MessageType,
	messageBody: string,
	user: IUser,
	room: IRoom,
	matrixRoomId: string,
	eventId: EventID,
	thread?: { tmid: string; tshow: boolean },
): Promise<{
	fromId: string;
	rid: string;
	msg: string;
	federation_event_id: string;
	thread?: { tmid: string; tshow: boolean };
	attachments: [FileAttachmentProps];
}> {
	const mimeType = fileInfo?.mimetype;
	const fileName = messageBody;

	const fileRefId = await MatrixMediaService.downloadAndStoreRemoteFile(url, matrixRoomId, {
		name: messageBody,
		size: fileInfo?.size,
		type: mimeType,
		roomId: room._id,
		userId: user._id,
	});

	let fileExtension = '';
	if (fileName?.includes('.')) {
		fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
	} else if (mimeType?.includes('/')) {
		fileExtension = mimeType.split('/')[1] || '';
		if (fileExtension === 'jpeg') {
			fileExtension = 'jpg';
		}
	}

	const fileUrl = `/file-upload/${fileRefId}/${encodeURIComponent(fileName)}`;

	let attachment: FileAttachmentProps = {
		title: fileName,
		type: 'file',
		title_link: fileUrl,
		title_link_download: true,
		description: '',
	};

	if (msgtype === 'm.image') {
		attachment = {
			...attachment,
			image_url: fileUrl,
			image_type: mimeType,
			image_size: fileInfo?.size || 0,
			...(fileInfo?.w &&
				fileInfo?.h && {
					image_dimensions: {
						width: fileInfo.w,
						height: fileInfo.h,
					},
				}),
		};
	} else if (msgtype === 'm.video') {
		attachment = {
			...attachment,
			video_url: fileUrl,
			video_type: mimeType,
			video_size: fileInfo?.size || 0,
		};
	} else if (msgtype === 'm.audio') {
		attachment = {
			...attachment,
			audio_url: fileUrl,
			audio_type: mimeType,
			audio_size: fileInfo?.size || 0,
		};
	}

	return {
		fromId: user._id,
		rid: room._id,
		msg: '',
		federation_event_id: eventId,
		thread,
		attachments: [attachment],
	};
}

export function message(emitter: Emitter<HomeserverEventSignatures>, serverName: string) {
	emitter.on('homeserver.matrix.message', async (data) => {
		try {
			const { content } = data;
			const { msgtype } = content;
			const messageBody = content.body.toString();

			if (!messageBody && !msgtype) {
				logger.debug('No message content found in event');
				return;
			}

			// at this point we know for sure the user already exists
			const user = await Users.findOneByUsername(data.sender);
			if (!user) {
				throw new Error(`User not found for sender: ${data.sender}`);
			}

			const room = await Rooms.findOne({ 'federation.mrid': data.room_id });
			if (!room) {
				throw new Error(`No mapped room found for room_id: ${data.room_id}`);
			}

			const relation = content['m.relates_to'];

			// SPEC: For example, an m.thread relationship type denotes that the event is part of a “thread” of messages and should be rendered as such.
			const hasRelation = relation && 'rel_type' in relation;

			const isThreadMessage = hasRelation && relation.rel_type === 'm.thread';

			const threadRootEventId = isThreadMessage && relation.event_id;

			// SPEC: Though rich replies form a relationship to another event, they do not use rel_type to create this relationship.
			// Instead, a subkey named m.in_reply_to is used to describe the reply’s relationship,
			const isRichReply = relation && !('rel_type' in relation) && 'm.in_reply_to' in relation;

			const quoteMessageEventId = isRichReply && relation['m.in_reply_to']?.event_id;

			const thread = threadRootEventId ? await getThreadMessageId(threadRootEventId) : undefined;

			const isEditedMessage = hasRelation && relation.rel_type === 'm.replace';
			if (isEditedMessage && relation.event_id && data.content['m.new_content']) {
				logger.debug('Received edited message from Matrix, updating existing message');
				const originalMessage = await Messages.findOneByFederationId(relation.event_id);
				if (!originalMessage) {
					logger.error('Original message not found for edit:', relation.event_id);
					return;
				}
				if (originalMessage.federation?.eventId !== relation.event_id) {
					return;
				}
				if (originalMessage.msg === data.content['m.new_content']?.body) {
					logger.debug('No changes in message content, skipping update');
					return;
				}

				if (quoteMessageEventId) {
					const messageToReplyToUrl = await MeteorService.getMessageURLToReplyTo(room.t as string, room._id, originalMessage._id);
					const formatted = await toInternalQuoteMessageFormat({
						messageToReplyToUrl,
						formattedMessage: data.content.formatted_body || '',
						rawMessage: messageBody,
						homeServerDomain: serverName,
						senderExternalId: data.sender,
					});
					await Message.updateMessage(
						{
							...originalMessage,
							msg: formatted,
						},
						user,
						originalMessage,
					);
					return;
				}

				const formatted = toInternalMessageFormat({
					rawMessage: data.content['m.new_content'].body,
					formattedMessage: data.content.formatted_body || '',
					homeServerDomain: serverName,
					senderExternalId: data.sender,
				});
				await Message.updateMessage(
					{
						...originalMessage,
						msg: formatted,
					},
					user,
					originalMessage,
				);
				return;
			}

			if (quoteMessageEventId) {
				const originalMessage = await Messages.findOneByFederationId(quoteMessageEventId);
				if (!originalMessage) {
					logger.error('Original message not found for quote:', quoteMessageEventId);
					return;
				}
				const messageToReplyToUrl = await MeteorService.getMessageURLToReplyTo(room.t as string, room._id, originalMessage._id);
				const formatted = await toInternalQuoteMessageFormat({
					messageToReplyToUrl,
					formattedMessage: data.content.formatted_body || '',
					rawMessage: messageBody,
					homeServerDomain: serverName,
					senderExternalId: data.sender,
				});
				await Message.saveMessageFromFederation({
					fromId: user._id,
					rid: room._id,
					msg: formatted,
					federation_event_id: data.event_id,
					thread,
				});
				return;
			}

			const isMediaMessage = Object.values(fileTypes).includes(msgtype as FileMessageType);
			if (isMediaMessage && content.url) {
				const result = await handleMediaMessage(
					content.url,
					content.info,
					msgtype,
					messageBody,
					user,
					room,
					data.room_id,
					data.event_id,
					thread,
				);
				await Message.saveMessageFromFederation(result);
			} else {
				const formatted = toInternalMessageFormat({
					rawMessage: messageBody,
					formattedMessage: data.content.formatted_body || '',
					homeServerDomain: serverName,
					senderExternalId: data.sender,
				});
				await Message.saveMessageFromFederation({
					fromId: user._id,
					rid: room._id,
					msg: formatted,
					federation_event_id: data.event_id,
					thread,
				});
			}
		} catch (error) {
			logger.error(error, 'Error processing Matrix message:');
		}
	});

	emitter.on('homeserver.matrix.encrypted', async (data) => {
		try {
			if (!data.content.ciphertext) {
				logger.debug('No message content found in event');
				return;
			}

			// at this point we know for sure the user already exists
			const user = await Users.findOneByUsername(data.sender);
			if (!user) {
				throw new Error(`User not found for sender: ${data.sender}`);
			}

			const room = await Rooms.findOne({ 'federation.mrid': data.room_id });
			if (!room) {
				throw new Error(`No mapped room found for room_id: ${data.room_id}`);
			}

			const relation = data.content['m.relates_to'];

			// SPEC: For example, an m.thread relationship type denotes that the event is part of a “thread” of messages and should be rendered as such.
			const hasRelation = relation && 'rel_type' in relation;

			const isThreadMessage = hasRelation && relation.rel_type === 'm.thread';

			const threadRootEventId = isThreadMessage && relation.event_id;

			// SPEC: Though rich replies form a relationship to another event, they do not use rel_type to create this relationship.
			// Instead, a subkey named m.in_reply_to is used to describe the reply’s relationship,
			const isRichReply = relation && !('rel_type' in relation) && 'm.in_reply_to' in relation;

			const quoteMessageEventId = isRichReply && relation['m.in_reply_to']?.event_id;

			const thread = threadRootEventId ? await getThreadMessageId(threadRootEventId) : undefined;

			const isEditedMessage = hasRelation && relation.rel_type === 'm.replace';
			if (isEditedMessage && relation.event_id) {
				logger.debug('Received edited message from Matrix, updating existing message');
				const originalMessage = await Messages.findOneByFederationId(relation.event_id);
				if (!originalMessage) {
					logger.error('Original message not found for edit:', relation.event_id);
					return;
				}
				if (originalMessage.federation?.eventId !== relation.event_id) {
					return;
				}
				if (originalMessage.content?.ciphertext === data.content.ciphertext) {
					logger.debug('No changes in message content, skipping update');
					return;
				}

				if (quoteMessageEventId) {
					await Message.updateMessage(
						{
							...originalMessage,
							content: {
								algorithm: data.content.algorithm,
								ciphertext: data.content.ciphertext,
							},
						},
						user,
						originalMessage,
					);
					return;
				}

				await Message.updateMessage(
					{
						...originalMessage,
						content: {
							algorithm: data.content.algorithm,
							ciphertext: data.content.ciphertext,
						},
					},
					user,
					originalMessage,
				);
				return;
			}

			if (quoteMessageEventId) {
				const originalMessage = await Messages.findOneByFederationId(quoteMessageEventId);
				if (!originalMessage) {
					logger.error('Original message not found for quote:', quoteMessageEventId);
					return;
				}
				await Message.saveMessageFromFederation({
					fromId: user._id,
					rid: room._id,
					e2e_content: {
						algorithm: data.content.algorithm,
						ciphertext: data.content.ciphertext,
					},
					federation_event_id: data.event_id,
					thread,
				});
				return;
			}

			await Message.saveMessageFromFederation({
				fromId: user._id,
				rid: room._id,
				e2e_content: {
					algorithm: data.content.algorithm,
					ciphertext: data.content.ciphertext,
				},
				federation_event_id: data.event_id,
				thread,
			});
		} catch (error) {
			logger.error(error, 'Error processing Matrix message:');
		}
	});

	emitter.on('homeserver.matrix.redaction', async (data) => {
		try {
			const redactedEventId = data.redacts;
			if (!redactedEventId) {
				logger.debug('No redacts field in redaction event');
				return;
			}

			const messageEvent = await FederationMatrix.getEventById(redactedEventId);
			if (!messageEvent || messageEvent.event.type !== 'm.room.message') {
				logger.debug(`Event ${redactedEventId} is not a message event`);
				return;
			}

			const rcMessage = await Messages.findOneByFederationId(data.redacts);
			if (!rcMessage) {
				logger.debug(`No RC message found for event ${data.redacts}`);
				return;
			}
			const internalUsername = data.sender;
			const user = await Users.findOneByUsername(internalUsername);
			if (!user) {
				logger.debug(`User not found: ${internalUsername}`);
				return;
			}

			await Message.deleteMessage(user, rcMessage);
		} catch (error) {
			logger.error('Failed to process Matrix removal redaction:', error);
		}
	});
}
