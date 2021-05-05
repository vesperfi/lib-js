'use strict'

require('dotenv').config()
require('chai').should()
const { pools, tokens } = require('vesper-metadata')
const Big = require('big.js')
const erc20Abi = require('erc-20-abi')
const HDWalletProvider = require('@truffle/hdwallet-provider')
const Web3 = require('web3')

const createVesper = require('..')
const swapEthForTokens = require('./swap-eth-for-tokens')
const wrapEth = require('./wrap-eth')

const overestimation = Number.parseInt(process.env.GAS_OVERESTIMATION || '2')

const amounts = {
  DAI: '10000000000000000000', // 10 DAI
  ETH: '100000000000000000', // 0.1 ETH
  USDC: '10000000', // 10 USDC
  VSP: '100000000000000000', // 0.1 VSP
  WBTC: '1000000', // 0.01 WBTC
  WETH: '100000000000000000' // 0.1 WETH
}

describe('E2E', function () {
  this.timeout(0)

  let from
  let web3

  before(function () {
    if (!process.env.E2E) {
      this.skip()
      return
    }

    const provider = new HDWalletProvider({
      addressIndex: Number.parseInt(process.env.ACCOUNT || '0'),
      mnemonic: process.env.MNEMONIC,
      numberOfAddresses: 1,
      providerOrUrl: process.env.NODE_URL || 'http://127.0.0.1:8545'
    })
    from = Web3.utils.toChecksumAddress(provider.getAddress(0))
    web3 = new Web3(provider)
  })

  // eslint-disable-next-line mocha/no-setup-in-describe
  pools
    .filter(pool =>
      process.env.TEST_STAGES
        ? process.env.TEST_STAGES.split('+').includes(pool.stage)
        : pool.stage !== 'retired'
    )
    .map(pool => ({
      ...pool,
      amount: amounts[pool.asset] || '1000000000000000000'
    }))
    .forEach(function ({ name, address, asset, stage, amount }) {
      describe(name, function () {
        before(function () {
          const vesper = createVesper(web3, {
            from,
            overestimation,
            stages: [stage]
          })
          if (asset === 'ETH') {
            return null
          }
          // Wrap ETH
          if (asset === 'WETH') {
            return wrapEth(web3, '1000000000000000000', from).then(function (
              receipt
            ) {
              receipt.should.have.property('status').that.is.true
              Big(receipt.events.Deposit.returnValues.wad).gte(amount).should.be
                .true
            })
          }
          // Swap ETH for asset
          return (
            asset !== 'ETH' &&
            vesper[address]
              .getAssetAddress()
              .then(assetAddress =>
                swapEthForTokens(
                  web3,
                  '1000000000000000000',
                  assetAddress,
                  from
                )
              )
              .then(function (receipt) {
                receipt.should.have.property('status').that.is.true
                Big(receipt.events.Transfer.returnValues.value).gte(
                  amount
                ).should.be.true
              })
          )
        })

        it(`should deposit ${asset}`, function () {
          const vesper = createVesper(web3, {
            from,
            overestimation,
            stages: [stage]
          })
          // Get current pool balance
          return vesper[address]
            .getBalance()
            .then(balance =>
              Promise.all([
                // Deposit asset
                vesper[address].deposit(amount).promise,
                balance
              ])
            )
            .then(function ([result, oldBalance]) {
              // Check result
              result.should.have.property('sent', amount)
              result.should.have.property('fees').that.match(/^[0-9]+$/)
              result.should.have.property('received').that.match(/^[0-9]+$/)
              result.should.have.property('status', true)
              result.should.have.property('raw').that.is.an('array')
              // Check transaction receipt
              const { receipt } = result.raw.pop()
              receipt.should.have.property('status').that.is.true
              receipt.should.have.nested
                .property('events.Transfer')
                .that.is.an(asset !== 'ETH' ? 'array' : 'object')
              const transfer = []
                .concat(receipt.events.Transfer)
                .find(e => e.address.toLowerCase() === address.toLowerCase())
              transfer.should.exist
              transfer.should.have.nested.property(
                'returnValues.from',
                '0x0000000000000000000000000000000000000000'
              )
              transfer.should.have.nested.property('returnValues.to', from)
              transfer.should.have.nested
                .property('returnValues.value')
                .that.match(/^[0-9]+$/)
              return Promise.all([
                // Check new pool balance
                vesper[address].getBalance(),
                oldBalance,
                transfer.returnValues.value
              ])
            })
            .then(function ([balance, oldBalance, value]) {
              balance.should.equal(Big(oldBalance).plus(value).toFixed())
            })
        })

        it(`should withdraw ${asset}`, function () {
          if (name === 'vVSP') {
            // vVSP has a withdraw timelock of 24h so this test does not apply
            this.skip()
            return null
          }
          const vesper = createVesper(web3, {
            from,
            overestimation,
            stages: [stage]
          })
          // Deposit asset
          return vesper[address]
            .deposit(amount)
            .promise.then(function (result) {
              const { receipt } = result.raw.pop()
              receipt.should.have.property('status').that.is.true
              return Promise.all([
                // Get current asset and pool token balance
                vesper[address].getAssetBalance(),
                vesper[address].getBalance(),
                vesper[address].getDepositedBalance()
              ])
            })
            .then(function ([
              assetBalance,
              poolTokenBalance,
              depositedBalance
            ]) {
              return Promise.all([
                assetBalance,
                poolTokenBalance,
                // Withdraw asset
                vesper[address].withdraw(depositedBalance).promise
              ])
            })
            .then(function ([assetBalance, poolTokenBalance, result]) {
              // Check result
              result.should.have.property('sent')
              const roundError = Big(
                `2e${18 - Number.parseInt(result.decimals)}`
              ).toFixed()
              Big(result.sent)
                .minus(poolTokenBalance)
                .abs()
                .lte(roundError).should.be.true
              result.should.have.property('fees').that.match(/^[0-9]+$/)
              result.should.have.property('received').that.match(/^[0-9]+$/)
              result.should.have.property('status', true)
              result.should.have.property('raw').that.is.an('array')
              // Check transaction receipt
              const { transaction, receipt } = result.raw.pop()
              receipt.should.have.property('status').that.is.true
              receipt.should.have.nested
                .property('events.Withdraw')
                .that.is.an('object')
              const withdraw = receipt.events.Withdraw
              withdraw.should.have.nested.property('returnValues.owner', from)
              withdraw.should.have.nested.property('returnValues.shares')
              Big(withdraw.returnValues.shares)
                .minus(poolTokenBalance)
                .abs()
                .lte(roundError).should.be.true
              withdraw.should.have.nested
                .property('returnValues.amount')
                .that.match(/^[0-9]+$/)
              // Calculate new asset balance
              const withdrawFee =
                asset !== 'ETH'
                  ? Big(0)
                  : Big(transaction.gasPrice).times(receipt.gasUsed)
              const expectedBalance = Big(assetBalance)
                .sub(withdrawFee)
                .plus(withdraw.returnValues.amount)
              return Promise.all([
                expectedBalance,
                // Get new asset balance
                vesper[address].getAssetBalance()
              ])
            })
            .then(function ([expectedBalance, balance]) {
              // Check new asset balance
              expectedBalance.eq(balance).should.be.true
            })
        })

        it('should set vVSP withdraw timelock')

        it(`should claim VSP tokens on ${name}`, function () {
          // TODO check if the pool has rewards instead
          if (name === 'vVSP' || name === 'vBetaETH') {
            this.skip()
            return null
          }
          const _this = this
          const vesper = createVesper(web3, {
            from,
            overestimation,
            stages: [stage]
          })
          const vspAddress = tokens.find(token => token.symbol === 'VSP')
            .address
          const vspToken = new web3.eth.Contract(erc20Abi, vspAddress)
          // Deposit asset
          return vesper[address]
            .deposit(amount)
            .promise.then(function (result) {
              const { receipt } = result.raw.pop()
              receipt.should.have.property('status').that.is.true
              return Promise.all([
                // Get VSP balance
                vspToken.methods.balanceOf(from).call(),
                // Get claimable VSP balance
                vesper[address].getClaimableVsp()
              ])
            })
            .then(function ([vspBalance, claimableBalance]) {
              // Check there is claimable balance
              if (Big(claimableBalance).eq(0)) {
                _this.skip()
                throw new Error('Rewards not enabled for pool?')
              }
              return Promise.all([
                // Claim VSP
                vesper[address].claimVsp().promise,
                Big(vspBalance).plus(claimableBalance).toFixed()
              ])
            })
            .then(function ([result, expectedBalance]) {
              // Check result
              result.should.have.property('fees').that.match(/^[0-9]+$/)
              result.should.have.property('received').that.match(/^[0-9]+$/)
              result.should.have.property('status', true)
              result.should.have.property('raw').that.is.an('array')
              // Check transaction receipt
              const { receipt } = result.raw.pop()
              receipt.should.have.property('status').that.is.true
              // Get VSP balance
              return Promise.all([
                expectedBalance,
                vspToken.methods.balanceOf(from).call()
              ])
            })
            .then(function ([expectedBalance, balance]) {
              // Check new VSP balance
              Big(balance).gte(expectedBalance).should.be.true
            })
        })

        it(`should rebalance ${name}`, function () {
          const _this = this
          const vesper = createVesper(web3, {
            from,
            overestimation,
            stages: [stage]
          })
          // Deposit asset
          return vesper[address]
            .deposit(amount)
            .promise.then(function () {
              // Check if pool can be rebalanced
              return vesper[address].canRebalance()
            })
            .then(function (canRebalance) {
              if (!canRebalance) {
                _this.skip()
                throw new Error('Cannot rebanalce pool')
              }
              // Rebalance pool
              return vesper[address].rebalance().promise
            })
            .then(function (result) {
              // Check result
              result.should.have.property('fees').that.match(/^[0-9]+$/)
              result.should.have.property('status', true)
              result.should.have.property('raw').that.is.an('array')
              // Check transaction receipt
              const { receipt } = result.raw.pop()
              receipt.should.have.property('status').that.is.true
            })
        })

        it(`should get ${name} value locked`, function () {
          const vesper = createVesper(web3, {
            from,
            overestimation,
            stages: [stage]
          })
          // Get current value locked
          return vesper[address].getValueLocked().then(function (valueLocked) {
            valueLocked.should.be.a('string').that.match(/^[0-9]+$/)
          })
        })
      })
    })
})
