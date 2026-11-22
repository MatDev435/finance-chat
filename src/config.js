import { join, resolve } from 'node:path';

const MIN_SECRET_LENGTH = 32;
const COOKIE_SECURE_MODES = new Set(['auto', 'true', 'false']);

export class ConfigError extends Error {
  constructor(problems) {
    super(`Configuração inválida:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

function flag(value, fallback = false) {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'sim'].includes(value.trim().toLowerCase());
}

function validTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Reads and validates the process configuration. Never returns secrets in error messages. */
export function loadConfig(env = process.env) {
  const problems = [];

  const appSecret = (env.APP_SECRET || '').trim();
  if (appSecret.length < MIN_SECRET_LENGTH || appSecret.startsWith('replace-with')) {
    problems.push(`APP_SECRET é obrigatória e precisa ter pelo menos ${MIN_SECRET_LENGTH} caracteres aleatórios. `
      + 'Gere uma com: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"');
  }

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT precisa ser um número entre 1 e 65535.');

  const cookieSecure = (env.COOKIE_SECURE || 'auto').trim().toLowerCase();
  if (!COOKIE_SECURE_MODES.has(cookieSecure)) problems.push('COOKIE_SECURE precisa ser auto, true ou false.');

  const timeZone = (env.APP_TIME_ZONE || 'America/Sao_Paulo').trim();
  if (!validTimeZone(timeZone)) problems.push(`APP_TIME_ZONE inválido: ${timeZone}`);

  if (problems.length) throw new ConfigError(problems);

  const dataDir = resolve(env.DATA_DIR?.trim() || './data');
  const desktopDir = env.DESKTOP_DIR?.trim() ? resolve(env.DESKTOP_DIR.trim()) : join(dataDir, 'desktop');
  return Object.freeze({
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    dataDir,
    databasePath: join(dataDir, 'finance-chat.sqlite'),
    actualDataDir: join(dataDir, 'actual'),
    desktopDir,
    appSecret,
    trustProxy: flag(env.TRUST_PROXY),
    cookieSecure,
    allowSignup: flag(env.ALLOW_SIGNUP),
    timeZone,
  });
}
