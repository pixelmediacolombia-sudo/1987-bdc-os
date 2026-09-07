const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { enrichInboundMedia } = require("../dist/modules/media/application/enrich-inbound-media");
const { FixtureMediaUnderstandingAdapter } = require("../dist/modules/media/application/fixture-media-understanding.adapter");
const { SofiaConversationEngine } = require("../dist/modules/decisions/domain/sofia-conversation");
const policy = require("../policies/country_club_cars_v8.json");

const AUDIO_DIR = path.join(__dirname, "..", "tmp", "synthetic-country-club-audio");

const samples = [
  {
    id: "01-family-suv",
    filename: "01-family-suv.wav",
    transcript: "Soy Carlos, busco una SUV para mi familia y tengo dos mil quinientos dolares para el enganche.",
    expected: { contact_name: "Carlos", vehicle_category: "suv", down_payment_declared: 2500 },
  },
  {
    id: "02-corolla-no-trade",
    filename: "02-corolla-no-trade.wav",
    transcript: "Buenas, busco una Toyota Corolla y tengo mil quinientos para el enganche. No tengo carro para dar de parte de pago.",
    expected: { vehicle_model_interest: "Toyota Corolla", vehicle_category: "sedan", down_payment_declared: 1500, has_trade_in: false },
  },
  {
    id: "03-work-truck-income-letter",
    filename: "03-work-truck-income-letter.wav",
    transcript: "Soy Ana. Busco una troca, tengo dos mil de enganche y carta del trabajo.",
    expected: { contact_name: "Ana", vehicle_category: "work truck", down_payment_declared: 2000, has_income_proof: true },
  },
];

function createSyntheticWav(filePath, frequency) {
  const sampleRate = 16000;
  const durationSeconds = 1;
  const sampleCount = sampleRate * durationSeconds;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 2800);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  fs.writeFileSync(filePath, buffer);
}

async function main() {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const fixtureResults = {};
  for (const [index, sample] of samples.entries()) {
    const localPath = path.join(AUDIO_DIR, sample.filename);
    createSyntheticWav(localPath, 380 + index * 80);
    fixtureResults[sample.filename] = { kind: "audio", text: sample.transcript, source: "fixture" };
  }
  const adapter = new FixtureMediaUnderstandingAdapter(fixtureResults);
  const engine = new SofiaConversationEngine(policy.sofia);
  const results = [];
  for (const sample of samples) {
    const localPath = path.join(AUDIO_DIR, sample.filename);
    const event = {
      externalId: `synthetic-${sample.id}`,
      inboundMessage: {
        contactId: `synthetic-${sample.id}`,
        content: "Adjunto de audio",
        attachments: [{ kind: "audio", filename: sample.filename, localPath }],
      },
    };
    const enriched = await enrichInboundMedia(event, adapter, { info() {}, error(message) { throw new Error(message); } });
    const transcript = enriched.inboundMessage.content;
    const turn = engine.processTurn({
      dealerName: "Country Club Cars Inc.",
      latestMessage: transcript,
      priorFacts: {},
      contactChannel: "whatsapp",
      language: "es",
      turnCount: 1,
      isFirstTurn: true,
    });
    for (const [key, value] of Object.entries(sample.expected)) assert.deepEqual(turn.facts[key], value, `${sample.id} ${key}`);
    results.push({ id: sample.id, file: sample.filename, bytes: fs.statSync(localPath).size, source: "fixture-synthetic-audio", transcript, facts: turn.facts, response: turn.response });
  }
  const summary = { syntheticAudioFiles: results.length, mediaPipelinePassed: true, sofiaFactChecksPassed: results.length, realCountryClubAudio: false, results };
  console.log(`SYNTHETIC_AUDIO_LOCAL_SUMMARY ${JSON.stringify(summary)}`);
}

main().catch((error) => {
  console.error(`SYNTHETIC_AUDIO_LOCAL_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
