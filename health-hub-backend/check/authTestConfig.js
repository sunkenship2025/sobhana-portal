const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
});

function requireEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing ${name} in health-hub-backend/.env`);
  }

  return value;
}

const STAFF_CREDS = {
  email: 'tirupati@sobhana.com',
  password: requireEnv('STAFF_ACCOUNT_PASSWORD'),
};

const ADMIN_CREDS = {
  email: 'cto@sobhana.com',
  password: requireEnv('CTO_ACCOUNT_PASSWORD'),
};

const OWNER_CREDS = {
  email: 'owner@sobhana.com',
  password: requireEnv('OWNER_ACCOUNT_PASSWORD'),
};

module.exports = {
  STAFF_CREDS,
  ADMIN_CREDS,
  OWNER_CREDS,
};
