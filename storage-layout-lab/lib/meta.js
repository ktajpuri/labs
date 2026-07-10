const fs = require("fs");
const { META_FILE } = require("./config");

function readMeta() {
  if (!fs.existsSync(META_FILE)) {
    throw new Error(`${META_FILE} not found — run \`npm run generate\` first.`);
  }
  return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
}

module.exports = { readMeta };
