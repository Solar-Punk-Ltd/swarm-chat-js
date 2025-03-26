/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/swarm_event_emitter.json`.
 */
export type SwarmEventEmitter = {
  address: 'Eai8D93JKad51sYmft1r74fzLkBSwRGPQVAmwZoLoWDf';
  metadata: {
    name: 'swarmEventEmitter';
    version: '0.1.0';
    spec: '0.1.0';
    description: 'Created with Anchor';
  };
  instructions: [
    {
      name: 'addToWhitelist';
      discriminator: [157, 211, 52, 54, 144, 81, 5, 55];
      accounts: [
        {
          name: 'state';
          writable: true;
        },
        {
          name: 'admin';
          signer: true;
        },
      ];
      args: [
        {
          name: 'user';
          type: 'pubkey';
        },
      ];
    },
    {
      name: 'emitMessage';
      discriminator: [118, 99, 20, 87, 25, 132, 207, 62];
      accounts: [
        {
          name: 'state';
          writable: true;
        },
        {
          name: 'user';
          signer: true;
        },
      ];
      args: [
        {
          name: 'message';
          type: 'string';
        },
      ];
    },
    {
      name: 'initialize';
      discriminator: [175, 175, 109, 31, 13, 152, 155, 237];
      accounts: [
        {
          name: 'state';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [115, 116, 97, 116, 101];
              },
            ];
          };
        },
        {
          name: 'admin';
          writable: true;
          signer: true;
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
      ];
      args: [];
    },
    {
      name: 'removeFromWhitelist';
      discriminator: [7, 144, 216, 239, 243, 236, 193, 235];
      accounts: [
        {
          name: 'state';
          writable: true;
        },
        {
          name: 'admin';
          signer: true;
        },
      ];
      args: [
        {
          name: 'user';
          type: 'pubkey';
        },
      ];
    },
  ];
  accounts: [
    {
      name: 'state';
      discriminator: [216, 146, 107, 94, 104, 75, 182, 177];
    },
  ];
  events: [
    {
      name: 'messageLogged';
      discriminator: [24, 236, 247, 207, 227, 70, 101, 210];
    },
    {
      name: 'removedFromWhitelist';
      discriminator: [107, 247, 94, 185, 182, 200, 82, 172];
    },
    {
      name: 'whitelisted';
      discriminator: [235, 202, 86, 232, 226, 75, 139, 182];
    },
  ];
  errors: [
    {
      code: 6000;
      name: 'notAdmin';
      msg: 'Only the admin can perform this action.';
    },
    {
      code: 6001;
      name: 'notWhitelisted';
      msg: 'You are not whitelisted.';
    },
  ];
  types: [
    {
      name: 'messageLogged';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'sender';
            type: 'pubkey';
          },
          {
            name: 'message';
            type: 'string';
          },
        ];
      };
    },
    {
      name: 'removedFromWhitelist';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'account';
            type: 'pubkey';
          },
        ];
      };
    },
    {
      name: 'state';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'admin';
            type: 'pubkey';
          },
          {
            name: 'whitelisted';
            type: {
              vec: 'pubkey';
            };
          },
        ];
      };
    },
    {
      name: 'whitelisted';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'account';
            type: 'pubkey';
          },
        ];
      };
    },
  ];
};
