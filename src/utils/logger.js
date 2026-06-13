import winston from 'winston'

const { combine, timestamp, colorize, printf } = winston.format

const fmt = printf(({ level, message, timestamp, ...meta }) => {
  const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''
  return `${timestamp} [${level}] ${message}${extras}`
})

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(timestamp({ format: 'HH:mm:ss' }), colorize(), fmt),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/crawler.log',
      format: combine(timestamp(), fmt),
      options: { flags: 'a' },
    }),
  ],
})
