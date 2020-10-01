var express = require("express");
var router = express.Router();

const {
  makeRandomPrivKey,
  privateKeyToString,
  getAddressFromPrivateKey,
  TransactionVersion,
  StacksTestnet,
  uintCV,
  tupleCV,
  makeContractCall,
  bufferCV,
  serializeCV,
  deserializeCV,
  cvToString,
  broadcastTransaction,
} = require("@blockstack/stacks-transactions");
const {
  InfoApi,
  AccountsApi,
  SmartContractsApi,
  Configuration,
  TransactionsApi,
  connectWebSocketClient,
} = require("@stacks/blockchain-api-client");
const c32 = require("c32check");

// by default will try to access a local node @ localhost:20443
const apiConfig = new Configuration({
  fetchApi: fetch,
  // basePath: "http://localhost:20443",
  basePath: "https://stacks-node-api.blockstack.org",
});

// generate random key
const privateKey = makeRandomPrivKey();

// get Stacks address
const stxAddress = getAddressFromPrivateKey(
  privateKeyToString(privateKey),
  TransactionVersion.Testnet
);

/* GET stacking info. */
router.get("/info", async function (req, res, next) {
  const info = new InfoApi(apiConfig);

  const poxInfo = await info.getPoxInfo();
  const coreInfo = await info.getCoreApiInfo();
  const blocktimeInfo = await info.getNetworkBlockTimes();

  console.log({ poxInfo, coreInfo, blocktimeInfo });

  // will Stacking be executed in the next cycle?
  const stackingExecution = poxInfo.rejection_votes_left_required > 0;

  // how long (in seconds) is a Stacking cycle?
  const cycleDuration =
    poxInfo.reward_cycle_length * blocktimeInfo.testnet.target_block_time;

  // how much time is left (in seconds) until the next cycle begins?
  const secondsToNextCycle =
    (poxInfo.reward_cycle_length -
      ((coreInfo.burn_block_height - poxInfo.first_burnchain_block_height) %
        poxInfo.reward_cycle_length)) *
    blocktimeInfo.testnet.target_block_time;

  // the actual datetime of the next cycle start
  const nextCycleStartingAt = new Date();
  nextCycleStartingAt.setSeconds(
    nextCycleStartingAt.getSeconds() + secondsToNextCycle
  );

  // this would be provided by the user
  let numberOfCycles = 3;

  // the projected datetime for the unlocking of tokens
  const unlockingAt = new Date(nextCycleStartingAt);
  unlockingAt.setSeconds(
    unlockingAt.getSeconds() +
      poxInfo.reward_cycle_length *
        numberOfCycles *
        blocktimeInfo.testnet.target_block_time
  );

  res.json({
    stackingExecution,
    cycleDuration,
    secondsToNextCycle,
    nextCycleStartingAt,
    numberOfCycles,
    unlockingAt,
    minimumUSTX: poxInfo.min_amount_ustx,
  });
});

/* GET cycle details. */
router.get("/user", async function (req, res, next) {
  const info = new InfoApi(apiConfig);
  const accounts = new AccountsApi(apiConfig);

  const poxInfo = await info.getPoxInfo();

  const accountBalance = await accounts.getAccountBalance({
    principal: stxAddress,
  });

  const accountSTXBalance = accountBalance.stx.balance;

  // enough balance for participation?
  const canParticipate = accountSTXBalance >= poxInfo.min_amount_ustx;

  res.json({
    stxAddress,
    btcAddress: c32.c32ToB58(stxAddress),
    accountSTXBalance,
    canParticipate,
  });
});

/* GET eligibility details. */
router.get("/eligible", async function (req, res, next) {
  const info = new InfoApi(apiConfig);
  const smartContracts = new SmartContractsApi(apiConfig);
  const poxInfo = await info.getPoxInfo();

  const stacksAddress = poxInfo.contract_id.split(".")[0];
  const contractName = poxInfo.contract_id.split(".")[1];
  const functionName = "can-stack-stx";

  let microSTXoLockup = poxInfo.min_amount_ustx;
  let numberOfCycles = 3;

  // note: if this isn't working, check the local node logs:
  // https://docs.blockstack.org/mining

  // generate BTC from Stacks address
  const hashbytes = bufferCV(
    Buffer.from(c32.c32addressDecode(stxAddress)[1], "hex")
  );
  const version = bufferCV(Buffer.from("01", "hex"));

  const isEligible = await smartContracts.callReadOnlyFunction({
    stacksAddress,
    contractName,
    functionName,
    readOnlyFunctionArgs: {
      sender: stxAddress,
      arguments: [
        `0x${serializeCV(
          tupleCV({
            hashbytes,
            version,
          })
        ).toString("hex")}`,
        `0x${serializeCV(uintCV(microSTXoLockup)).toString("hex")}`,
        `0x${serializeCV(uintCV(poxInfo.reward_cycle_id)).toString("hex")}`,
        `0x${serializeCV(uintCV(numberOfCycles)).toString("hex")}`,
      ],
    },
  });

  const response = cvToString(
    deserializeCV(Buffer.from(isEligible.result.slice(2), "hex"))
  );

  if (response.startsWith(`(err `)) {
    // error cases
    return res.json({ isEligible: false });
  }
  // success
  res.json({ isEligible: true });
});

/* GET stack STX */
router.get("/stack", async function (req, res, next) {
  const info = new InfoApi(apiConfig);
  const tx = new TransactionsApi(apiConfig);
  const poxInfo = await info.getPoxInfo();

  let microSTXoLockup = poxInfo.min_amount_ustx;
  let numberOfCycles = 3;

  // generate BTC from Stacks address
  const hashbytes = bufferCV(
    Buffer.from(c32.c32addressDecode(stxAddress)[1], "hex")
  );
  const version = bufferCV(Buffer.from("01", "hex"));

  const contractAddress = poxInfo.contract_id.split(".")[0];
  const contractName = poxInfo.contract_id.split(".")[1];
  const functionName = "stack-stx";
  const network = new StacksTestnet();

  const txOptions = {
    contractAddress,
    contractName,
    functionName,
    functionArgs: [
      uintCV(microSTXoLockup),
      tupleCV({
        hashbytes,
        version,
      }),
      uintCV(numberOfCycles),
    ],
    senderKey: privateKey.data.toString("hex"),
    validateWithAbi: true,
    network,
  };

  const transaction = await makeContractCall(txOptions);

  const contractCall = await broadcastTransaction(transaction, network);

  console.log(contractCall);

  res.json({ txId: contractCall.txid });
});

/* GET stacker info */
router.get("/stacker-info", async function (req, res, next) {
  const info = new InfoApi(apiConfig);
  const smartContracts = new SmartContractsApi(apiConfig);
  const poxInfo = await info.getPoxInfo();

  const contractAddress = poxInfo.contract_id.split(".")[0];
  const contractName = poxInfo.contract_id.split(".")[1];
  const functionName = "get-stacker-info";

  const stackingInfo = await smartContracts.callReadOnlyFunction({
    contractAddress,
    contractName,
    functionName,
    readOnlyFunctionArgs: {
      sender: stxAddress,
      arguments: [
        `0x${serializeCV(standardPrincipalCV(stxAddress)).toString("hex")}`,
      ],
    },
  });

  const response = cvToString(
    deserializeCV(Buffer.from(stackingInfo.result.slice(2), "hex"))
  );

  res.json({ response });
});

router.get("/ping-tx", async function (req, res, next) {
  subscribeForTransactionCompletion(
    "0x7ab7da60d159e444062f76694fa9e08c03d3fb4c3776f6880a772987076ba9bd"
  );
});

async function pollForTransactionSuccess(txId) {
  const tx = new TransactionsApi(apiConfig);
  let resp;
  const intervalID = setInterval(async () => {
    resp = await tx.getTransactionById({ txId });
    console.log(resp);
    if (resp.tx_status === "success") {
      // stop polling
      clearInterval(intervalID);
      return resp;
    }
  }, 3000);
}

async function subscribeForTransactionCompletion(txId) {
  const client = await connectWebSocketClient(
    "ws://stacks-node-api.blockstack.org/"
  );

  const sub = await client.subscribeAddressTransactions(txId, (event) => {
    console.log(event);
  });

  await sub.unsubscribe();
}

module.exports = router;
