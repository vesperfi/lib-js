'use strict'

const { tokens } = require('@uniswap/default-token-list')
const debug = require('debug')('vesper-lib:uniswap')
const pTap = require('p-tap')

const uniswapV2Router02Abi = require('./abi/uniswap-v2-router-02.json')
const { fromUnit } = require('./utils')

const uniswapV2Router02Address = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'

const createUniswapRouter = function (web3, vspAddress) {
  const uniswapV2Router02 = new web3.eth.Contract(
    uniswapV2Router02Abi,
    uniswapV2Router02Address
  )

  // Gets the address of an ERC-20 token by symbol - hacked for VSP
  const getTokenAddressOf = symbol =>
    symbol === 'VSP'
      ? vspAddress
      : tokens.find(token => token.symbol === symbol).address

  // Gets the address of an ERC-20 token by symbol - hacked for VSP
  const getTokenDecimalsOf = symbol =>
    symbol === 'VSP'
      ? 18
      : tokens.find(token => token.symbol === symbol).decimals

  // Gets the amounts of tokens to get in a swap
  const getAmountOut = function (amount, tokensPath, defaultBlock) {
    return uniswapV2Router02.methods
      .getAmountsOut(amount, tokensPath.map(getTokenAddressOf))
      .call({}, defaultBlock)
      .then(amounts => amounts[amounts.length - 1])
  }

  const oneVsp = '1000000000000000000'

  // Gets the VSP rate in WETH or in another token.
  // For tokens other than WETH, the router must go through WETH first,
  // otherwise it throws an error.
  const getVspRate = function (toToken) {
    debug('Getting VSP/%s rate', toToken)
    return (vspAddress
      ? toToken === 'VSP'
        ? Promise.resolve(oneVsp)
        : toToken === 'WETH'
        ? getAmountOut(oneVsp, ['VSP', 'WETH'])
        : getAmountOut(oneVsp, ['VSP', 'WETH', toToken])
      : Promise.reject(new Error('VSP address missing'))
    )
      .catch(function (err) {
        debug('Could not get VSP/%s rate: %s', toToken, err.message)
        return '0'
      })
      .then(
        pTap(function (rate) {
          debug(
            'VSP/%s rate is %s',
            toToken,
            fromUnit(rate, getTokenDecimalsOf(toToken))
          )
        })
      )
  }

  // Swap ETH for tokens
  const swapEthForTokens = (tokenAddress, { from, value }) =>
    uniswapV2Router02.methods
      .swapExactETHForTokens(
        1, // amountOutMin
        [getTokenAddressOf('WETH'), tokenAddress],
        from,
        Math.round(Date.now() / 1000) + 60
      )
      .send({ from, gas: 200000, value })

  return {
    getAmountOut,
    getTokenAddressOf,
    getVspRate,
    swapEthForTokens
  }
}

module.exports = createUniswapRouter
