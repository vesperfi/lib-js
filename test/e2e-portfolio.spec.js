'use strict'

require('dotenv').config()
require('chai').should()
const Web3 = require('web3')

const createVesper = require('..')

const address = '0xdf826ff6518e609E4cEE86299d40611C148099d5'

describe('E2E', function () {
  this.timeout(0)

  before(function () {
    if (!process.env.E2E) {
      this.skip()
    }
  })

  describe('Portfolio', function () {
    it("should get the user's portfolio", function () {
      const web3 = new Web3(process.env.NODE_URL)
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
      const web3 = new Web3(process.env.NODE_URL)
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
