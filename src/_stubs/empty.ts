// Empty stub for removed packages
const handler = new Proxy(
  {},
  {
    get: () => handler,
    construct: () => handler,
    apply: () => handler,
  },
);
export default handler;
export const WebClient = class {};
export const messagingApi = handler;
export { handler as Client, handler as createAudioPlayer, handler as joinVoiceChannel };
