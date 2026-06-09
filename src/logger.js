import { EOL } from 'node:os';

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const levelNames = Object.keys(LEVELS);

let currentLevel = LEVELS.INFO;

function timestamp() {
  const now = new Date();
  const Y = String(now.getFullYear());
  const M = String(now.getMonth() + 1).padStart(2, '0');
  const D = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}.${ms}`;
}

function formatValue(value) {
  if (value === undefined || value === null) return String(value);
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.message}${value.stack ? `${EOL}${value.stack}` : ''}`;
  try {
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
  } catch {
    // circular or non-serializable
  }
  return String(value);
}

function log(level, context, ...args) {
  if (LEVELS[level] < currentLevel) return;

  const header = `[${timestamp()}] [${level.padEnd(5)}] [${context.padEnd(10)}]`;
  const message = args.map(formatValue).join(' ');

  if (level === 'ERROR') {
    console.error(`${header} ${message}`);
  } else if (level === 'WARN') {
    console.warn(`${header} ${message}`);
  } else {
    console.log(`${header} ${message}`);
  }
}

const noop = () => {};

export function createLogger(context) {
  return {
    debug: noop,
    info(...args) {
      log('INFO', context, ...args);
    },
    warn(...args) {
      log('WARN', context, ...args);
    },
    error(...args) {
      log('ERROR', context, ...args);
    },
  };
}

export function setLogLevel(level) {
  const key = String(level).toUpperCase();
  if (Reflect.has(LEVELS, key)) {
    currentLevel = LEVELS[key];
  }
}
