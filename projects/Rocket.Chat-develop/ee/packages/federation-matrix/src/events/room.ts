import { Room } from '@rocket.chat/core-services';
import type { Emitter } from '@rocket.chat/emitter';
import type { HomeserverEventSignatures, HomeserverServices } from '@rocket.chat/federation-sdk';
import { Rooms, Users } from '@rocket.chat/models';

import { getUsernameServername } from '../FederationMatrix';

export function room(emitter: Emitter<HomeserverEventSignatures>, services: HomeserverServices) {
	emitter.on('homeserver.matrix.room.name', async (data) => {
		const { room_id: roomId, name, user_id: userId } = data;

		const localRoomId = await Rooms.findOne({ 'federation.mrid': roomId }, { projection: { _id: 1 } });
		if (!localRoomId) {
			throw new Error('mapped room not found');
		}

		const localUserId = await Users.findOneByUsername(userId, { projection: { _id: 1 } });
		if (!localUserId) {
			throw new Error('mapped user not found');
		}

		await Room.saveRoomName(localRoomId._id, localUserId._id, name);
	});

	emitter.on('homeserver.matrix.room.topic', async (data) => {
		const { room_id: roomId, topic, user_id: userId } = data;

		const localRoomId = await Rooms.findOne({ 'federation.mrid': roomId }, { projection: { _id: 1 } });
		if (!localRoomId) {
			throw new Error('mapped room not found');
		}

		const localUser = await Users.findOneByUsername(userId, { projection: { _id: 1, federation: 1, federated: 1 } });
		if (!localUser) {
			throw new Error('mapped user not found');
		}

		await Room.saveRoomTopic(localRoomId._id, topic, {
			_id: localUser._id,
			username: userId,
			federation: localUser.federation,
			federated: localUser.federated,
		});
	});

	emitter.on('homeserver.matrix.room.role', async (data) => {
		const { room_id: roomId, user_id: userId, sender_id: senderId, role } = data;

		const localRoomId = await Rooms.findOne({ 'federation.mrid': roomId }, { projection: { _id: 1 } });
		if (!localRoomId) {
			throw new Error('mapped room not found');
		}

		const [allegedUsernameLocal, , allegedUserLocalIsLocal] = getUsernameServername(userId, services.config.serverName);
		const localUserId = allegedUserLocalIsLocal && (await Users.findOneByUsername(allegedUsernameLocal, { projection: { _id: 1 } }));

		if (!allegedUserLocalIsLocal) {
			return;
		}

		if (!localUserId) {
			throw new Error('mapped user not found');
		}

		const [senderUsername, , senderIsLocal] = getUsernameServername(senderId, services.config.serverName);

		if (senderIsLocal) {
			return;
		}

		const localSenderId = await Users.findOneByUsername(senderUsername, { projection: { _id: 1 } });
		if (!localSenderId) {
			throw new Error('mapped user not found');
		}

		await Room.addUserRoleRoomScoped(localSenderId._id, localUserId._id, localRoomId._id, role);
	});
}
