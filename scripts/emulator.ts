/**
 * Helpers for local development with the Pub/Sub emulator.
 *
 *   npm run emulator:setup                    create the topic and subscription
 *   npm run emulator:publish -- [chainId] [match]   publish one fake match
 *
 * Both need PUBSUB_EMULATOR_HOST, so they never touch a real GCP project.
 */
import { PubSub } from "@google-cloud/pubsub";

const projectId = process.env.GOOGLE_CLOUD_PROJECT || "sourcify-project";
const topicName = process.env.PUBSUB_TOPIC || "sourcify-staging-new-match";
const subscriptionName =
  process.env.PUBSUB_SUBSCRIPTION || "sourcify-staging-live-stats";

async function setup(pubsub: PubSub): Promise<void> {
  const topic = pubsub.topic(topicName);
  const [topicExists] = await topic.exists();
  if (!topicExists) await topic.create();
  const subscription = topic.subscription(subscriptionName);
  const [subExists] = await subscription.exists();
  if (!subExists) await topic.createSubscription(subscriptionName);
  console.log(`Ready: topic ${topicName}, subscription ${subscriptionName}`);
}

async function publish(pubsub: PubSub, args: string[]): Promise<void> {
  const chainId = Number(args[0] ?? 8453);
  const match = args[1] ?? "exact_match";
  // A fake id from the clock, so that each run gives a higher total.
  const matchId = String(Math.floor(Date.now() / 1000));
  const address = `0x${[...Array(40)].map(() => Math.floor(Math.random() * 16).toString(16)).join("")}`;
  const now = new Date().toISOString();
  const entry = {
    jsonPayload: {
      message: "Stored to SourcifyDatabase",
      matchId,
      address,
      chainId,
      runtimeMatch: match === "exact_match" ? "perfect" : "partial",
      creationMatch: null,
      match,
      service: "server",
      timestamp: now,
    },
    resource: {
      type: "cloud_run_revision",
      labels: { service_name: "sourcify-staging-server" },
    },
    timestamp: now,
  };
  const id = await pubsub
    .topic(topicName)
    .publishMessage({ data: Buffer.from(JSON.stringify(entry)) });
  console.log(`Published message ${id}: matchId=${matchId} chainId=${chainId}`);
}

async function main(): Promise<void> {
  if (!process.env.PUBSUB_EMULATOR_HOST) {
    console.error("Set PUBSUB_EMULATOR_HOST (for example localhost:8085).");
    process.exit(1);
  }
  const [command, ...args] = process.argv.slice(2);
  const pubsub = new PubSub({ projectId });
  if (command === "setup") await setup(pubsub);
  else if (command === "publish") await publish(pubsub, args);
  else throw new Error(`Unknown command "${command}". Use setup or publish.`);
  await pubsub.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
