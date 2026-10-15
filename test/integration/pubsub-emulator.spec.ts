import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PubSub } from "@google-cloud/pubsub";
import logger from "../../src/logger";
import { startSubscriber } from "../../src/pubsub";
import type { NewMatch } from "../../src/types";
import { logEntry } from "../helpers";

// Needs the Pub/Sub emulator. Start it with one of:
//   gcloud beta emulators pubsub start --project=test-project --host-port=localhost:8085
//   docker run --rm -p 8085:8085 gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
//     gcloud beta emulators pubsub start --project=test-project --host-port=0.0.0.0:8085
// Then run: PUBSUB_EMULATOR_HOST=localhost:8085 npm run test:integration
const emulatorHost = process.env.PUBSUB_EMULATOR_HOST;
const skip = emulatorHost
  ? false
  : "PUBSUB_EMULATOR_HOST is not set; start the Pub/Sub emulator to run this test (see README)";

describe("Pub/Sub subscriber (emulator)", { skip }, () => {
  it("receives matches, and skips bad messages", async () => {
    const projectId = "test-project";
    const name = `live-stats-test-${randomUUID()}`;
    const pubsub = new PubSub({ projectId });
    const [topic] = await pubsub.createTopic(name);
    await topic.createSubscription(name);

    const received: NewMatch[] = [];
    const subscriber = startSubscriber({
      projectId,
      subscription: `projects/${projectId}/subscriptions/${name}`,
      logger,
      onMatch: (m) => received.push(m),
    });

    try {
      await topic.publishMessage({ data: Buffer.from("not json") });
      await topic.publishMessage({
        data: Buffer.from(
          logEntry({
            matchId: "100",
            chainId: 8453,
            address: "0x0d89Cb4f4220B7BECB5A54f9e16De41a615987FC",
            match: "exact_match",
          }),
        ),
      });

      for (let i = 0; i < 200 && received.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(received.length, 1);
      assert.equal(received[0].matchId, "100");
      assert.equal(received[0].chainId, "8453");
    } finally {
      await subscriber.close();
      await pubsub.subscription(name).delete();
      await topic.delete();
      await pubsub.close();
    }
  });
});
