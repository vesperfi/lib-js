'use strict'

const debug = require('debug')('vesper-lib:info')
const Big = require('big.js').default
const pTap = require('p-tap')

const getPoolStatus = (paused, stopped) =>
  stopped ? 'stopped' : paused ? 'paused' : 'operative'

const createPoolsInfo = (contractsPromise, vesper, uniswapRouter) => ({
  // Returns general information of the pools.
  getPools(stages) {
    debug('Getting pools information (%s)', stages ? stages.join(', ') : 'all')

    return contractsPromise
      .then(({ pools, poolContracts, assetContracts }) =>
        Promise.all(
          pools
            .filter(pool => !stages || stages.includes(pool.stage))
            .map(pool =>
              Promise.all([
                vesper[pool.address].getInterestEarned(),
                vesper[pool.address].getInterestFee(),
                vesper[pool.address].getVspRewardsRate(),
                vesper[pool.address].getTokenValue(),
                vesper[pool.address].getTotalSupply(),
                vesper[pool.address].getWithdrawFee(),
                vesper[pool.address].hasVspRewards(),
                poolContracts[pool.address].methods.decimals().call(),
                poolContracts[pool.address].methods.paused().call(),
                poolContracts[pool.address].methods.stopEverything().call(),
                poolContracts[pool.address].methods.totalValue().call(),
                pool.asset === 'ETH'
                  ? '18'
                  : assetContracts[pool.asset].methods.decimals().call(),
                pool.asset === 'ETH'
                  ? null
                  : assetContracts[pool.asset].options.address,
                pool.name === 'vVSP'
                  ? poolContracts[pool.address].methods.lockPeriod().call()
                  : '0',
                uniswapRouter.getVspRate(
                  pool.asset === 'ETH' ? 'WETH' : pool.asset
                )
              ]).then(
                ([
                  interestEarned,
                  interestFee,
                  vspRewardsRate,
                  tokenValue,
                  totalSupply,
                  withdrawFee,
                  vspRewards,
                  decimals,
                  paused,
                  stopEverything,
                  totalValue,
                  assetDecimals,
                  assetAddress,
                  lockPeriod,
                  vspRate
                ]) => ({
                  ...pool,
                  asset: {
                    address: assetAddress,
                    decimals: assetDecimals,
                    symbol: pool.asset
                  },
                  collRewardsRate: Big(vspRewardsRate)
                    .mul(vspRate)
                    .div(1e18)
                    .toFixed(0),
                  decimals,
                  interestEarned,
                  interestFee,
                  lockPeriod: Number.parseInt(lockPeriod),
                  status: getPoolStatus(paused, stopEverything),
                  tokenValue,
                  totalSupply,
                  totalValue,
                  vspRewards,
                  vspRewardsRate,
                  withdrawFee
                })
              )
            )
        )
      )
      .then(
        pTap(function (poolsData) {
          debug(
            'Got pools information for %s',
            poolsData.map(pool => pool.name).join(', ')
          )
        })
      )
  }
})

module.exports = createPoolsInfo
