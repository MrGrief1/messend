import { FederationMatrix } from '@rocket.chat/core-services';
import { isEditedMessage, type IMessage, type IRoom, type IUser } from '@rocket.chat/core-typings';
import { Rooms } from '@rocket.chat/models';

import { callbacks } from '../../../../lib/callbacks';
import { afterLeaveRoomCallback } from '../../../../lib/callbacks/afterLeaveRoomCallback';
import { afterRemoveFromRoomCallback } from '../../../../lib/callbacks/afterRemoveFromRoomCallback';
import { beforeAddUsersToRoom, beforeAddUserToRoom } from '../../../../lib/callbacks/beforeAddUserToRoom';
import { beforeChangeRoomRole } from '../../../../lib/callbacks/beforeChangeRoomRole';
import { FederationActions } from '../../../../server/services/room/hooks/BeforeFederationActions';

// callbacks.add('federation-event-example', async () => FederationMatrix.handleExample(), callbacks.priority.MEDIUM, 'federation-event-example-handler');

// TODO: move this to the hooks folder
callbacks.add('federation.afterCreateFederatedRoom', async (room, { owner, originalMemberList: members, options }) => {
	if (FederationActions.shouldPerformFederationAction(room)) {
		const federatedRoomId = options?.federatedRoomId;

		if (!federatedRoomId) {
			// if room exists, we don't want to create it again
			// adds bridge record
			await FederationMatrix.createRoom(room, owner, members);
		} else {
			// matrix room was already created and passed
			const fromServer = federatedRoomId.split(':')[1];

			await Rooms.setAsFederated(room._id, {
				mrid: federatedRoomId,
				origin: fromServer,
			});
		}
	}
});

callbacks.add(
	'afterSaveMessage',
	async (message, { room, user }) => {
		if (!FederationActions.shouldPerformFederationAction(room)) {
			return;
		}

		try {
			// TODO: Check if message already exists in the database, if it does, don't send it to the federation to avoid loops
			// If message is federated, it will save external_message_id like into the message object
			// if this prop exists here it should not be sent to the federation to avoid loops
			if (!message.federation?.eventId) {
				await FederationMatrix.sendMessage(message, room, user);
			}
		} catch (error) {
			// Log the error but don't prevent the message from being sent locally
			console.error('[sendMessage] Failed to send message to Native Federation:', error);
		}
	},
	callbacks.priority.HIGH,
	'native-federation-after-room-message-sent',
);

callbacks.add(
	'afterDeleteMessage',
	async (message: IMessage, { room }) => {
		if (!message.federation?.eventId) {
			return;
		}

		if (FederationActions.shouldPerformFederationAction(room)) {
			await FederationMatrix.deleteMessage(room.federation.mrid, message);
		}
	},
	callbacks.priority.MEDIUM,
	'native-federation-after-delete-message',
);

beforeAddUsersToRoom.add(async ({ usernames }, room) => {
	if (FederationActions.shouldPerformFederationAction(room)) {
		await FederationMatrix.ensureFederatedUsersExistLocally(usernames);
	}
});

beforeAddUserToRoom.add(
	async ({ user, inviter }, room) => {
		if (!user.username || !inviter) {
			return;
		}

		if (FederationActions.shouldPerformFederationAction(room)) {
			await FederationMatrix.inviteUsersToRoom(room, [user.username], inviter);
		}
	},
	callbacks.priority.MEDIUM,
	'native-federation-on-before-add-users-to-room',
);

callbacks.add(
	'afterSetReaction',
	async (message: IMessage, params): Promise<void> => {
		// Don't federate reactions that came from Matrix
		if (params.user.username?.includes(':')) {
			return;
		}
		if (FederationActions.shouldPerformFederationAction(params.room)) {
			await FederationMatrix.sendReaction(message._id, params.reaction, params.user);
		}
	},
	callbacks.priority.HIGH,
	'federation-matrix-after-set-reaction',
);

callbacks.add(
	'afterUnsetReaction',
	async (_message: IMessage, params): Promise<void> => {
		// Don't federate reactions that came from Matrix
		if (params.user.username?.includes(':')) {
			return;
		}
		if (FederationActions.shouldPerformFederationAction(params.room)) {
			await FederationMatrix.removeReaction(params.oldMessage._id, params.reaction, params.user, params.oldMessage);
		}
	},
	callbacks.priority.HIGH,
	'federation-matrix-after-unset-reaction',
);

afterLeaveRoomCallback.add(
	async ({ user, kicker }, room: IRoom): Promise<void> => {
		if (FederationActions.shouldPerformFederationAction(room)) {
			await FederationMatrix.leaveRoom(room._id, user, kicker);
		}
	},
	callbacks.priority.HIGH,
	'federation-matrix-after-leave-room',
);

afterRemoveFromRoomCallback.add(
	async (data: { removedUser: IUser; userWhoRemoved: IUser }, room: IRoom): Promise<void> => {
		if (FederationActions.shouldPerformFederationAction(room)) {
			await FederationMatrix.kickUser(room, data.removedUser, data.userWhoRemoved);
		}
	},
	callbacks.priority.HIGH,
	'federation-matrix-after-remove-from-room',
);

callbacks.add(
	'afterRoomNameChange',
	async ({ room, name, user }) => {
		if (FederationActions.shouldPerformFederationAction(room)) {
			await FederationMatrix.updateRoomName(room._id, name, user);
		}
	},
	callbacks.priority.HIGH,
	'federation-matrix-after-room-name-changed',
);

callbacks.add(
	'afterRoomTopicChange',
	async (_, { room, topic, user }) => {
		if (FederationActions.shouldPerformFederationAction(room)) {
			await FederationMatrix.updateRoomTopic(room, topic, user);
		}
	},
	callbacks.priority.HIGH,
	'federation-matrix-after-room-topic-changed',
);

callbacks.add(
	'afterSaveMessage',
	async (message: IMessage, { room }) => {
		if (FederationActions.shouldPerformFederationAction(room)) {
			if (!isEditedMessage(message)) {
				return;
			}

			await FederationMatrix.updateMessage(room, message);
		}
	},
	callbacks.priority.HIGH,
	'federation-matrix-after-room-message-updated',
);

beforeChangeRoomRole.add(
	async (params: { fromUserId: string; userId: string; room: IRoom; role: 'moderator' | 'owner' | 'leader' | 'user' }) => {
		if (FederationActions.shouldPerformFederationAction(params.room)) {
			await FederationMatrix.addUserRoleRoomScoped(params.room, params.fromUserId, params.userId, params.role);
		}
	},
	callbacks.priority.HIGH,
	'federation-matrix-before-change-room-role',
);

callbacks.add(
	'beforeCreateDirectRoom',
	async (members, room): Promise<void> => {
		if (FederationActions.shouldPerformFederationAction(room)) {
			await FederationMatrix.ensureFederatedUsersExistLocally(members);
		}
	},
	callbacks.priority.HIGH,
	'federation-matrix-before-create-direct-room',
);

callbacks.add(
	'afterCreateDirectRoom',
	async (room: IRoom, params: { members: IUser[]; creatorId: IUser['_id']; mrid?: string }): Promise<void> => {
		if (params.mrid) {
			await Rooms.setAsFederated(room._id, {
				mrid: params.mrid,
				origin: params.mrid.split(':').pop()!,
			});
			return;
		}
		if (FederationActions.shouldPerformFederationAction(room)) {
			await FederationMatrix.createDirectMessageRoom(room, params.members, params.creatorId);
		}
	},
	callbacks.priority.HIGH,
	'federation-matrix-after-create-direct-room',
);
