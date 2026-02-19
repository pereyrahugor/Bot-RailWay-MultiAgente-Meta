import { ProviderClass, EVENTS } from '@builderbot/bot';
import axios from 'axios';

class YCloudProvider extends ProviderClass {
    globalVendorArgs: any;

    constructor(args: any = {}) {
        super();
        this.globalVendorArgs = args;
    }

    protected initProvider() {
        console.log('[YCloudProvider] Listo. Esperando Webhooks...');
    }

    public async initVendor() {
        this.vendor = {};
        setTimeout(() => {
            this.emit('ready', true);
        }, 100);
        return this.vendor;
    }

    public beforeHttpServerInit() {
    }

    public afterHttpServerInit() {
    }

    public busEvents = () => {
        return [];
    };

    private normalizeType(msg: any): string {
        const type = msg.type;
        if (type === 'audio') return msg.audio?.voice ? EVENTS.VOICE_NOTE : EVENTS.MEDIA;
        if (type === 'image' || type === 'video') return EVENTS.MEDIA;
        if (type === 'document') return EVENTS.DOCUMENT;
        if (type === 'location') return EVENTS.LOCATION;
        if (type === 'interactive' || type === 'button') return EVENTS.ACTION;
        return type;
    }

    public async saveFile(ctx: any, { path: folderPath }: { path: string }) {
        try {
            const fs = await import('fs');
            const path = await import('path');
            const apiKey = process.env.YCLOUD_API_KEY;
            
            const media = ctx.payload?.image || ctx.payload?.video || ctx.payload?.audio || ctx.payload?.document;
            
            if (!media || !media.link) {
                console.log(`[YCloudProvider] No se detectó media o link para descargar.`);
                return null;
            }

            console.log(`[YCloudProvider] Descargando archivo multimedia...`);
            const response = await axios.get(media.link, { 
                responseType: 'arraybuffer',
                headers: { 'X-API-Key': apiKey } 
            });

            const ext = path.extname(media.link) || (media.mime_type ? `.${media.mime_type.split('/')[1]}` : '.bin');
            const fileName = `${Date.now()}-${media.id || 'file'}${ext}`;
            const fullPath = path.join(folderPath, fileName);
            
            fs.writeFileSync(fullPath, response.data);
            return fullPath;
        } catch (e) {
            console.error('[YCloudProvider] Error en saveFile:', e);
            return null;
        }
    }

    /**
     * Manda mensajes a través de la API de YCloud
     */
    public async sendMessage(number: string, message: string, options: any = {}): Promise<any> {
        const apiKey = process.env.YCLOUD_API_KEY;
        const fromNumber = process.env.YCLOUD_WABA_NUMBER;

        if (!apiKey) {
            console.error('[YCloudProvider] Error: YCLOUD_API_KEY no definida.');
            return;
        }

        if (!fromNumber) {
            console.error('[YCloudProvider] Error: YCLOUD_WABA_NUMBER no definida.');
            return;
        }

        const url = 'https://api.ycloud.com/v2/whatsapp/messages';
        const cleanNumber = number.replace(/\D/g, '');

        const body: any = {
            from: fromNumber.replace(/\D/g, ''),
            to: cleanNumber,
            type: 'text',
            text: { body: message }
        };

        // Soporte para envío de imágenes si se requiere
        if (options.media) {
            body.type = 'image';
            body.image = { url: options.media };
            delete body.text;
            if (message) {
                body.image.caption = message;
            }
        }

        try {
            const response = await axios.post(url, body, {
                headers: {
                    'X-API-Key': apiKey,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`📤 [YCloudProvider] Mensaje enviado a ${cleanNumber}`);
            return response.data;
        } catch (error: any) {
            console.error('[YCloudProvider] ❌ Error enviando mensaje:', JSON.stringify(error?.response?.data || error.message, null, 2));
            return Promise.resolve(null);
        }
    }

    /**
     * Webhook entrante
     */
    public handleWebhook = (req: any, res: any) => {
        try {
            const body = req.body;
            
            if (!res.headersSent) {
                res.statusCode = 200;
                res.end('OK');
            }

            if (!body) return;

            setImmediate(() => {
                this.processIncomingMessage(body);
            });
        } catch (e) {
            console.error('[YCloudProvider] Error en handleWebhook:', e);
        }
    }

    private processIncomingMessage = (body: any) => {
        try {
            const wabaNumberEnv = process.env.YCLOUD_WABA_NUMBER;

            // 1. Formato Nativo de YCloud
            if (body.type === 'whatsapp.inbound_message.received' && body.whatsappInboundMessage) {
                const msg = body.whatsappInboundMessage;

                if (wabaNumberEnv) {
                    const incomingDestNumber = (msg.to || '').replace(/\D/g, '');
                    const myWabaNumber = wabaNumberEnv.replace(/\D/g, '');
                    if (incomingDestNumber && incomingDestNumber !== myWabaNumber) return;
                }

                const normalizedType = this.normalizeType(msg);
                const formatedMessage: any = {
                    from: msg.wa_id || msg.from.replace('+', ''),
                    phoneNumber: msg.from.replace('+', ''),
                    name: msg.customerProfile?.name || 'User',
                    type: normalizedType,
                    body: normalizedType.startsWith('_event_') ? normalizedType : (msg.text?.body || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || msg.button?.text || ''),
                    payload: msg,
                    message: {
                        location: msg.location ? { degreesLatitude: msg.location.latitude, degreesLongitude: msg.location.longitude } : null,
                        audioMessage: msg.audio ? { mimetype: msg.audio.mime_type } : null,
                        imageMessage: msg.image ? { mimetype: msg.image.mime_type } : null,
                        videoMessage: msg.video ? { mimetype: msg.video.mime_type } : null,
                        documentMessage: msg.document ? { mimetype: msg.document.mime_type } : null
                    }
                };

                this.emit('message', formatedMessage);
            }
            // 2. Formato Meta (Directo si no pasa por el transformador de YCloud o similar)
            else if (body.object === 'whatsapp_business_account' || body.entry) {
                body.entry?.forEach((entry: any) => {
                    entry.changes?.forEach((change: any) => {
                        const value = change.value;
                        if (value?.messages) {
                            if (wabaNumberEnv && value.metadata) {
                                const incomingDestNumber = value.metadata.display_phone_number?.replace(/\D/g, '');
                                const myWabaNumber = wabaNumberEnv.replace(/\D/g, '');
                                if (incomingDestNumber !== myWabaNumber && value.metadata.phone_number_id !== myWabaNumber) return;
                            }

                            const contact = value.contacts?.[0];
                            const wa_id = contact?.wa_id;

                            value.messages.forEach((msg: any) => {
                                const normalizedType = this.normalizeType(msg);
                                const formatedMessage: any = {
                                    from: wa_id || msg.from.replace('+', ''),
                                    phoneNumber: msg.from.replace('+', ''),
                                    name: contact?.profile?.name || 'User',
                                    type: normalizedType,
                                    body: normalizedType.startsWith('_event_') ? normalizedType : (msg.text?.body || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || msg.button?.text || ''),
                                    payload: msg,
                                    message: {
                                        location: msg.location ? { degreesLatitude: msg.location.latitude, degreesLongitude: msg.location.longitude } : null,
                                        audioMessage: msg.audio ? { mimetype: msg.audio.mime_type } : null,
                                        imageMessage: msg.image ? { mimetype: msg.image.mime_type } : null,
                                        videoMessage: msg.video ? { mimetype: msg.video.mime_type } : null,
                                        documentMessage: msg.document ? { mimetype: msg.document.mime_type } : null
                                    }
                                };

                                this.emit('message', formatedMessage);
                            });
                        }
                    });
                });
            }
        } catch (e) {
            console.error('[YCloudProvider] ❌ Error procesando mensaje:', e);
        }
    }
}

export { YCloudProvider };
