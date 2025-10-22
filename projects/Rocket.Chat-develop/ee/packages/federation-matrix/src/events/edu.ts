import { api } from '@rocket.chat/core-services';
import { UserStatus } from '@rocket.chat/core-typings';
import type { Emitter } from '@rocket.chat/emitter';
import type { HomeserverEventSignatures } from '@rocket.chat/federation-sdk';
import { Logger } from '@rocket.chat/logger';
import { Rooms, Users } from '@rocket.chat/models';

const logger = new Logger('federation-matrix:edu');

export const edus = async (emitter: Emitter<HomeserverEventSignatures>, eduProcessTypes: { typing: boolean; presence: boolean }) => {
	emitter.on('homeserver.matrix.typing', async (data) => {
		if (!eduProcessTypes.typing) {
			return;
		}

		try {
			const matrixRoom = await Rooms.findOne({ 'federation.mrid': data.room_id }, { projection: { _id: 1 } });
			if (!matrixRoom) {
				logger.debug(`No bridged room found for Matrix room_id: ${data.room_id}`);
				return;
			}

			void api.broadcast('user.activity', {
				user: data.user_id,
				isTyping: data.typing,
				roomId: matrixRoom._id,
			});
		} catch (error) {
			logger.error('Error handling Matrix typing event:', error);
		}
	});

	emitter.on('homeserver.matrix.presence', async (data) => {
		if (!eduProcessTypes.presence) {
			return;
		}

		try {
			const matrixUser = await Users.findOneByUsername(data.user_id);
			if (!matrixUser) {
				logger.debug(`No federated user found for Matrix user_id: ${data.user_id}`);
				return;
			}

			if (!matrixUser.federated) {
				logger.debug(`User ${matrixUser.username} is not federated, skipping presence update from Matrix`);
				return;
			}

			const statusMap = {
				online: UserStatus.ONLINE,
				offline: UserStatus.OFFLINE,
				unavailable: UserStatus.AWAY,
			};

			const status = statusMap[data.presence] || UserStatus.OFFLINE;

			if (matrixUser.status === status) {
				logger.debug(`User ${matrixUser.username} already has status ${status}, skipping update`);
				return;
			}

			await Users.updateOne(
				{ _id: matrixUser._id },
				{
					$set: {
						status,
						statusDefault: status,
					},
				},
			);

			const { _id, username, statusText, roles, name } = matrixUser;
			void api.broadcast('presence.status', {
				user: { status, _id, username, statusText, roles, name },
				previousStatus: undefined,
			});
			logger.debug(`Updated presence for user ${matrixUser._id} to ${status} from Matrix federation`);
		} catch (error) {
			logger.error('Error handling Matrix presence event:', error);
		}
	});
};
