const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const log = {
  info: (...a) => console.log(`[${ts()}]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] ⚠️`, ...a),
  error: (...a) => console.error(`[${ts()}] ❌`, ...a),
};
