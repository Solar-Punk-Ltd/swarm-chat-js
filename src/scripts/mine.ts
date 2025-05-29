#!/usr/bin/env node
import { Bee, Identifier } from '@ethersphere/bee-js';

async function mine(beeUrl: string, topic: string) {
  const BEE = new Bee(beeUrl);
  const addresses = await BEE.getNodeAddresses();
  const identifier = Identifier.fromString(topic);
  const privateKey = BEE.gsocMine(addresses.overlay, identifier);
  console.log(privateKey.toString());
}

const beeUrl = process.argv[2] || 'http://localhost:1633';
const topic = process.argv[3] || 'DOOMSDAY';
mine(beeUrl, topic);
