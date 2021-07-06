# vesper-lib

Vesper JavaScript library.

This library is used by the [Vesper app](https://app.vesper.finance) and several supporting services.
Once instantiated, it exposes methods to operate with the Vesper contracts, query information, deposit, withdraw, claim VSP and more.

## Installation

```shell
npm install vesper-lib
```

## Usage

```js
const createVesper = require('vesper-lib')
const Web3 = require('web3')

const web3 = new Web3()

const vesper = createVesper(web3)

vesper.getPools().then(console.log)
// Prints information on all the pools

vesper.vETH.getBalance(myAccount).then(console.log)
// Prints my vETH balance
```

## API

### createVesper(web3, options)

Creates an instance of the Vesper lib using the provided Web3 instance.
Then the lib instance can be used to operate with the contracts.

#### Arguments

- `web3` (`object`): A `Web3` instance.
- `options` (`object`): An `object` with options for the library.
  - `from` (`{string}`): The address used to send transactions from.
  - `metadata` (`{string}`): Vesper metadata overrides for testing.
  - `overestimation` (`{number}`): Gas overestimation factor.
  - `stages` (`{string[]}`): List of pools to instantiate or `['all']`.

#### Returns

A `vesper` library instance.

### vesper.pool.method(params)

All the pool operations are exposed in the `vesper` instance and grouped by pool.

#### Selectors

- `pool`: The name of the pool (i.e. `vETH`) or the address (i.e. `0x103c...`).
- `method`: Any of the methods available in the pool. See below.
- `params`: The params of the corresponding method. See below.

#### Read methods

- `getAddress()`: Gets the address of the pool contract.
- `getAssetAddress()`: Gets the address of the deposit asset contract.
- `getStrategyAddresses()`: Gets the addresses of the strategy contracts.
- `getStrategyInfo(address)`: Gets the name and version of the given strategy contract.
- `getPoolRewardsAddress()`: Gets the address of the PoolRewards contract.
- `getPoolVersion()`: Gets the internal version of pool contract.

- `getBalance()`: Gets the user's balance of pool tokens.
- `getAssetBalance()`: Gets the user's balance of deposit assets.
- `getDepositedBalance()`: Gets the user's balance of pool tokens in deposit asset.
- `getWithdrawTimelock()`: Gets the time in ms until the withdraw lock will expire for the user.

- `hasVspRewards()`: Checks if the pool has VSP rewards.
- `getVspRewardsRate()`: Gets the VSP rewards rate in VSP/sec.
- `getClaimableVsp()`: Gets the balance of claimable VSP.

- `getTokenValue()`: Gets the value of a pool token in deposit assets.
- `getTotalSupply()`: Gets the total supply of pool tokens.
- `getValueLocked()`: Gets the value locked in the pool in USDC.
- `getInterestEarned()`: Gets the interest earned in deposit asset since the last rebalance.

- `getInterestFee()`: Gets the interes fee.
- `getWithdrawFee()`: Gets the withdraw fee.
- `isAddressWhitelisted(address)`: Checks if the address is in the no-withdraw-fee list of the pool.

- `isApprovalNeeded()`: Checks if an approval is needed to transfer the given amount.

##### Returns

A `Promise` with the requested data.

#### Signing methods

- `signPermit(spender, amount, deadline)`: Asks the user to sign an ERC-2612 permit.

#### Transaction methods

- `approveAndDeposit(approveAmount, depositAmount, transactionOptions)`: Approves and deposits assets in the pool.
- `deposit(amount, transactionOptions)`: Deposits assets in the pool.
- `withdraw(amount, transactionOptions)`: Withdraws deposit assets from the pool.
- `claimVsp(transactionOptions)`: Claims all claimable VSP in the pool.
- `migrate(transactionOptions)`: Migrates the balance tokens to a new pool.

##### Arguments

- `ammount` (`string`): The amount of deposit assets to operate.
- `transactionOptions` (`object`): The standard `web3` transaction options.

##### Returns

A `Promise` that resolves to an `object` summary of the operation.
The returned properties of the summary can be:

- `sent` (`string`): The amount of tokens sent.
- `fees` (`string`): The transaction fees in ETH.
- `received` (`string`): The amount of tokens received.
- `decimals` (`string`): The decimals of the received token.
- `raw` (`object[]`): An array of all the `{ transaction, receipt }` tuples.
- `status` (`boolean`): Whether the operation succeded.

## End-to-end testing

The following environment variables control how the tests run:

- `BASE_NODE_URL` is the URL of the node used to fork the chain (see below). Must be an archive node.
- `NODE_URL` is the URL used to communicate with the network.
- `MNEMONIC` is the 12-word mnemonic used to sign transactions.
- `ACCOUNT` is the BIP44 account number used to derive the signing keys from the mnemonic. Defaults to 0.

For convenience, define these environment variables in a `.env` file.
Then run the end-to-end tests:

```sh
npm run test:e2e
```

## License

MIT
