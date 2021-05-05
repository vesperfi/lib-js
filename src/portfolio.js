'use strict'

const debug = require('debug')('vesper-lib:portfolio')
const lodash = require('lodash')
const pProps = require('p-props')
const pTap = require('p-tap')

const createPortfolio = (contractsPromise, vesper, { from }) => ({
  // Returns the pool token balance and equivalent in deposit asset for each
  // pool.
  getPortfolio(address) {
    const _address = address || from

    debug('Getting portfolio of %s', _address)

    return contractsPromise
      .then(({ pools }) =>
        Promise.all(
          pools.map(pool =>
            pProps({
              assets: vesper[pool.address].getDepositedBalance(_address),
              claimableVsp: vesper[pool.address].getClaimableVsp(_address),
              timelock: vesper[pool.address].getWithdrawTimelock(_address),
              tokens: vesper[pool.address].getBalance(_address)
            }).then(balances => [pool.name, balances])
          )
        )
      )
      .then(lodash.fromPairs)
      .then(
        pTap(function (portfolio) {
          debug(
            'Got portfolio balances of %s',
            Object.keys(portfolio).join(', ')
          )
        })
      )
  },

  // Returns the balance of each deposit asset.
  getAssetPortfolio(address) {
    const _address = address || from

    debug('Getting asset portfolio of %s', _address)

    return contractsPromise
      .then(({ pools }) =>
        Promise.all(
          pools.map(pool =>
            vesper[pool.address]
              .getAssetBalance(_address)
              .then(balance => [pool.asset, balance])
          )
        )
      )
      .then(lodash.fromPairs)
      .then(
        pTap(function (portfolio) {
          debug(
            'Got asset portfolio balances of %s',
            Object.keys(portfolio).join(', ')
          )
        })
      )
  }
})

module.exports = createPortfolio
