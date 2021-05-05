'use strict'

require('dotenv').config()
require('chai').should()
const Web3 = require('web3')

const createVesper = require('..')

describe('E2E', function () {
  this.timeout(0)

  let address
  let web3

  before(function () {
    if (!process.env.E2E) {
      this.skip()
      return
    }

    address = '0xdf826ff6518e609E4cEE86299d40611C148099d5'
    web3 = new Web3(process.env.NODE_URL || 'http://127.0.0.1:8545')
  })

  describe('Portfolio', function () {
    it("should get the user's portfolio", function () {
      const vesper = createVesper(web3, { stages: ['-retired'] })
      return vesper.getPortfolio(address).then(function (portfolio) {
        portfolio.should.include.keys('vETH', 'vUSDC', 'vWBTC')
        Object.values(portfolio).forEach(function (pool) {
          pool.should.have.all.keys(
            'assets',
            'claimableVsp',
            'timelock',
            'tokens'
          )
          Object.values(pool).forEach(function (amount) {
            amount.should.match(/[0-9]+/)
          })
        })
      })
    })

    it("should get the user's asset portfolio", function () {
      const vesper = createVesper(web3, { stages: ['-retired'] })
      return vesper.getAssetPortfolio(address).then(function (portfolio) {
        portfolio.should.include.keys('ETH', 'WBTC')
        Object.values(portfolio).forEach(function (amount) {
          amount.should.match(/[0-9]+/)
        })
      })
    })
  })
})
