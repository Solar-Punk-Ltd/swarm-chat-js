import { Bee, Identifier } from '@ethersphere/bee-js';

const BEE_HOST = 'http://localhost:1633';

const BEE = new Bee(BEE_HOST);

async function mine(topic: string) {
  const addresses = await BEE.getNodeAddresses();
  const identifier = Identifier.fromString(topic);
  const privateKey = BEE.gsocMine(addresses.overlay, identifier);
  console.log(privateKey.toString());
}

mine('DOOMSDAY');
