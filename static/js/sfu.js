// Lightweight mediasoup-client integration loaded dynamically when window.SFU_URL is set
// Exposes window.SFU_JOIN(roomId, localStream)

(function(){
    const SFU_URL = window.SFU_URL || null; // e.g. 'https://your-sfu-host:4000'
    if (!SFU_URL) return; // No SFU configured

    let io_sfu = null;
    let mediasoupClient = null;

    async function ensureDeps() {
        if (!mediasoupClient) {
            // ESM import from CDN
            mediasoupClient = await import('https://unpkg.com/mediasoup-client@3.6.85/lib/index.js');
        }
        if (!io_sfu) {
            io_sfu = window.io ? window.io : await import('https://cdn.socket.io/4.7.5/socket.io.esm.min.js').then(m=>m.io);
        }
    }

    function request(socket, event, data) {
        return new Promise((resolve) => {
            socket.emit(event, data, (res) => resolve(res || {}));
        });
    }

    window.SFU_JOIN = async function(roomId, localStream){
        await ensureDeps();
        const socket = io_sfu(SFU_URL, { transports: ['websocket'] });
        await new Promise(res => socket.on('connect', res));

        console.log('[SFU] Подключение к комнате', roomId);

        const joinRes = await request(socket, 'sfu_join_room', { roomId });
        if (joinRes.error) throw new Error(joinRes.error);

        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: joinRes.routerRtpCapabilities });

        // Create send transport
        const sendInfo = await request(socket, 'sfu_create_transport', { roomId, direction: 'send' });
        if (sendInfo.error) throw new Error(sendInfo.error);
        const sendTransport = device.createSendTransport(sendInfo);
        sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            const r = await request(socket, 'sfu_connect_transport', { transportId: sendTransport.id, dtlsParameters });
            r.error ? errback(r.error) : callback();
        });
        sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
            const r = await request(socket, 'sfu_produce', { roomId, transportId: sendTransport.id, kind, rtpParameters });
            r.error ? errback(r.error) : callback({ id: r.id });
        });

        const audioTrack = localStream.getAudioTracks()[0];
        const videoTrack = localStream.getVideoTracks()[0];
        if (audioTrack) {
            console.log('[SFU] Отправка аудио трека');
            await sendTransport.produce({ track: audioTrack });
        }
        if (videoTrack) {
            console.log('[SFU] Отправка видео трека');
            await sendTransport.produce({ track: videoTrack });
        }

        // Create recv transport
        const recvInfo = await request(socket, 'sfu_create_transport', { roomId, direction: 'recv' });
        if (recvInfo.error) throw new Error(recvInfo.error);
        const recvTransport = device.createRecvTransport(recvInfo);
        recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            const r = await request(socket, 'sfu_connect_transport', { transportId: recvTransport.id, dtlsParameters });
            r.error ? errback(r.error) : callback();
        });

        // Храним consumers для отслеживания
        const consumers = new Map();

        socket.on('sfu_new_producer', async ({ producerId, kind }) => {
            console.log('[SFU] Новый producer:', producerId, kind);
            try {
                const params = await request(socket, 'sfu_consume', { roomId, transportId: recvTransport.id, producerId, rtpCapabilities: device.rtpCapabilities });
                if (params.error) {
                    console.warn('[SFU] Ошибка consume:', params.error);
                    return;
                }
                const consumer = await recvTransport.consume(params);
                consumers.set(consumer.id, consumer);
                
                await request(socket, 'sfu_resume_consumer', { consumerId: consumer.id });
                
                const track = consumer.track;
                const mediaEl = document.createElement(kind === 'video' ? 'video' : 'audio');
                mediaEl.dataset.consumerId = consumer.id;
                mediaEl.dataset.producerId = producerId;
                
                if (kind === 'video') { 
                    mediaEl.autoplay = true; 
                    mediaEl.playsInline = true;
                    mediaEl.style.width = '100%';
                    mediaEl.style.height = '100%';
                    mediaEl.style.objectFit = 'cover';
                } else { 
                    mediaEl.autoplay = true;
                    // НЕ делаем muted для удаленного аудио!
                }
                
                mediaEl.srcObject = new MediaStream([track]);
                const remote = document.getElementById('remoteVideos');
                if (remote) {
                    remote.appendChild(mediaEl);
                    console.log('[SFU] Добавлен удаленный', kind, 'элемент');
                }
            } catch (e) {
                console.error('[SFU] Ошибка обработки нового producer:', e);
            }
        });

        console.log('[SFU] Инициализация завершена');
    }
})();


