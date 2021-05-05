'use strict'

const erc20Abi = require('erc-20-abi')
const parseReceiptEvents = require('web3-parse-receipt-events')

const createUniswapRouter = require('../src/uniswap')

const swapEthForToken = function (web3, value, tokenAddress, from) {
  const uniswapRouter = createUniswapRouter(web3)

  return uniswapRouter
    .swapEthForTokens(tokenAddress, { from, value })
    .then(function (receipt) {
      parseReceiptEvents(erc20Abi, tokenAddress, receipt)
      return receipt
    })
}

module.exports = swapEthForToken
