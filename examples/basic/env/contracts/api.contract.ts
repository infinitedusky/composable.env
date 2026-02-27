import type { ServiceContract } from 'composable.env';

export const ApiContract: ServiceContract = {
  name: 'api',
  location: 'apps/api',
  required: {
    DATABASE_URL: '${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}',
    REDIS_URL: 'REDIS_URL',
  },
  optional: {
    LOG_LEVEL: 'LOG_LEVEL',
  },
  defaults: {
    LOG_LEVEL: 'info',
  },
};
