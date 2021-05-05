'use strict'

const { tokens } = require('@uniswap/default-token-list')
const Big = require('big.js')
const debug = require('debug')('vesper-lib')
const vesperMetadata = require('vesper-metadata')

const { fromUnit, toUnit } = require('./utils')
const createPoolMethods = require('./pool-methods')
const createPoolsInfo = require('./pools-info')
const createPortfolio = require('./portfolio')
const createUniswapRouter = require('./uniswap')
const getContracts = require('./contracts')

Big.RM = 0 // https://github.com/MikeMcl/big.js/blob/v5.2.2/big.js#L26

/**
 * Pools are placed into different stages according to their maturity:
 *
 * - test: For testing purposes only.
 * - alpha: For initial assessment of the stragegies, mostly by the core team.
 * - beta: Open for advanced users willing to test new pools.
 * - prod: Graduated pools for general use.
 * - retired: Pools no longer maintaned or superseded by other pools.
 */
const defaultStages = ['prod']

/**
 * Creates an instance of the Vesper lib using the provided Web3 instance.
 *
 * @param {object} web3 An initialized Web3 instance.
 * @param {object} [options] Additional library options.
 * @param {string} [options.from] The address used to send transactions from.
 * @param {string} [options.metadata] Vesper metadata overrides for testing.
 * @param {number} [options.overestimation] Gas overestimation factor.
 * @param {string[]} [options.stages] List of pools to instantiate or `['all']`.
 * @returns {object} The Vesper lib instance.
 */
function createVesper(web3, options = {}) {
  debug('Creating Vesper library instance')

  const { metadata = vesperMetadata, stages = defaultStages } = options

  const vesper = { metadata }

  // Filter pools
  const pools = metadata.pools
    .filter(
      pool =>
        // all stages
        stages.includes('all') ||
        // all not retired
        (stages.includes('-retired') && pool.stage !== 'retired') ||
        // only selected stages
        stages.includes(pool.stage)
    )
    .filter(pool => pool.address)
    .sort((a, b) => a.name.localeCompare(b.name))

  const contractsPromise = getContracts(web3, { ...metadata, pools })

  vesper.getContracts = () => contractsPromise

  // Create an Uniswap router
  const vspAddress = metadata.tokens.find(t => t.symbol === 'VSP').address
  const router = createUniswapRouter(web3, vspAddress)

  // Create general methods
  Object.assign(vesper, createPoolsInfo(contractsPromise, vesper, router))
  Object.assign(vesper, createPortfolio(contractsPromise, vesper, options))

  // Create pool-specific methods
  pools.forEach(function (pool) {
    debug('Adding pool %s methods', pool.name)
    const methods = createPoolMethods({
      ...pool,
      web3,
      contractsPromise: contractsPromise.then(
        ({ assetContracts, controllerContracts, poolContracts }) => ({
          assetContract: assetContracts[pool.asset],
          controllerContracts,
          poolContract: poolContracts[pool.address],
          poolContracts
        })
      ),
      tokens: tokens.concat(metadata.tokens),
      vspAddress,
      ...options
    })
    vesper[pool.name] = methods
    vesper[pool.address] = methods
  })

  return vesper
}

createVesper.metadata = vesperMetadata
createVesper.utils = { createUniswapRouter, fromUnit, toUnit }

module.exports = createVesper
