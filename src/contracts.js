'use strict'

const debug = require('debug')('vesper-lib:contracts')
const erc20Abi = require('erc-20-abi')
const tokenList = require('@uniswap/default-token-list').tokens

const collateralManagerAbi = require('./abi/collateral-manager.json')
const controllerAbi = require('./abi/controller.json')
const vesperPoolAbi = require('./abi/pool.json')

const getContracts = function (web3, metadata) {
  debug('Getting contracts')

  return web3.eth
    .getChainId()
    .then(function (id) {
      // Bypass ganache-core chainId issue by changing 1337 back to mainnet.
      // See: https://github.com/trufflesuite/ganache-core/issues/451
      return id === 1337 ? 1 : id
    })
    .then(function (id) {
      debug('Chain ID is %s', id)

      const controllers = metadata.controllers.filter(
        pool => pool.chainId === id
      )

      const collateralManager = new web3.eth.Contract(
        collateralManagerAbi,
        controllers.find(
          contract => contract.name === 'collateralManager'
        ).address
      )
      const controller = new web3.eth.Contract(
        controllerAbi,
        controllers.find(contract => contract.name === 'controller').address
      )

      const controllerContracts = { collateralManager, controller }

      const pools = metadata.pools.filter(pool => pool.chainId === id)

      if (!pools.length) {
        debug('No pool contracts in current chain!')
      }

      const poolContracts = pools
        .map(function (pool) {
          const { address, name } = pool
          const contract = new web3.eth.Contract(vesperPoolAbi, address)
          contract.meta = pool
          return { [address]: contract, [name]: contract }
        })
        .reduce((all, contract) => Object.assign(all, contract), {})

      const augmentedTokenList = tokenList
        .concat(metadata.tokens || [])
        .filter(token => token.chainId === id)

      const assetContracts = pools
        .map(pool => pool.asset)
        .filter(asset => asset !== 'ETH')
        .map(asset =>
          augmentedTokenList.find(
            token => token.symbol === asset && token.chainId === id
          )
        )
        .map(function (asset) {
          const { address, symbol } = asset
          const contract = new web3.eth.Contract(erc20Abi, address)
          return { [symbol]: contract }
        })
        .reduce((all, contract) => Object.assign(all, contract), {})

      return {
        assetContracts,
        controllerContracts,
        poolContracts,
        pools
      }
    })
}

module.exports = getContracts
