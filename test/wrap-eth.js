'use strict'

const parseReceiptEvents = require('web3-parse-receipt-events')

const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const wethAbi = [
  {
    constant: false,
    inputs: [],
    name: 'deposit',
    outputs: [],
    payable: true,
    stateMutability: 'payable',
    type: 'function'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'dst', type: 'address' },
      { indexed: false, name: 'wad', type: 'uint256' }
    ],
    name: 'Deposit',
    type: 'event'
  }
]

const wrapEth = function (web3, value, from) {
  const WETH = new web3.eth.Contract(wethAbi, wethAddress)
  return WETH.methods
    .deposit()
    .send({ from, gas: 150000, value })
    .then(function (receipt) {
      parseReceiptEvents(wethAbi, wethAddress, receipt)
      return receipt
    })
}

module.exports = wrapEth
