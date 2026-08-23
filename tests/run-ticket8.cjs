const path = require("node:path");
const moduleAlias = require("module-alias");

moduleAlias.addAlias("@", path.resolve(__dirname, "..", "dist-ticket8", "src"));
require(path.resolve(__dirname, "..", "dist-ticket8", "tests", "question-ledger-repetition.test.js"));
