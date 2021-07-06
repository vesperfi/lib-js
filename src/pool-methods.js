'use strict'

const Big = require('big.js').default
const debug = require('debug')('vesper-lib:pool')
const erc20Abi = require('erc-20-abi')
const parseReceiptEvents = require('web3-parse-receipt-events')
const pTap = require('p-tap')

const { fromUnit, toUnit } = require('./utils')
const aaveLendingPoolAbi = require('./abi/aaveLendingPoolAbi.json')
const addressListAbi = require('./abi/address-list.json')
const createExecutor = require('./exec-transactions')
const createUniswapRouter = require('./uniswap')
const eip1193 = require('./eip-1193')
const poolAbi = require('./abi/pool.json')
const poolRewardsAbi = require('./abi/pool-rewards.json')
const promiseLoop = require('./promise-loop')
const strategyAbi = require('./abi/strategy.json')
const strategyV3Abi = require('./abi/strategy-v3.json')
const vakAbi = require('./abi/mini-army-knife.json')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const findReturnValue = (receipt, eventName, prop, address) =>
  []
    .concat(receipt.events[eventName])
    .filter(
      event => !address || event.address.toLowerCase() === address.toLowerCase()
    )
    .map(event => event.returnValues[prop])[0]

/**
 * Creates the API -methods- to use the pool.
 *
 * @param {object} params The creation params.
 * @param {string} params.address Address of the pool.
 * @param {string} params.asset Name of the deposit asset.
 * @param {Promise} params.contractsPromise The pool and asset contracts.
 * @param {string} [params.from] The default transaction signing address.
 * @param {string} params.name Name of the pool and pool tokens.
 * @param {number} [params.overestimation] The gas over-estimation factor.
 * @param {string} [params.supersededBy] The pool that replaces the current one.
 * @param {object} params.tokens The list of known tokens.
 * @param {number} params.version The version of the pool's ABI.
 * @param {boolean} params.vakAddress The address of the VAK contract.
 * @param {boolean} params.vspAddress The address of the VSP token contract.
 * @param {boolean} [params.vspRewards] Flag to indicate VSP are granted.
 * @param {object} params.web3 A web3.js instance.
 * @returns {object} Pool methods.
 */
const createPoolMethods = function (params) {
  const {
    address: poolAddress,
    asset,
    contractsPromise,
    from,
    name,
    overestimation,
    supersededBy,
    tokens,
    version = 1,
    vakAddress,
    vspAddress,
    vspRewards,
    web3
  } = params

  const isToken = asset !== 'ETH'

  const assetDecimals = isToken
    ? tokens.find(t => t.symbol === asset).decimals
    : 18

  // Expected gas per transaction type.
  const expectedGasFor = {
    approval: 66000,
    claimVsp: 100000,
    deposit: 155000,
    migrate: 350000,
    rebalance: 825000,
    withdraw: 120000,
    withdrawEth: 120000
  }

  // A handy Uniswap router helper.
  const uniswapRouter = createUniswapRouter(web3, vspAddress)

  // Gets the address of the pool.
  const getAddress = () =>
    contractsPromise.then(({ poolContract }) => poolContract.options.address)

  // Gets the address of the deposit asset contract.
  const getAssetAddress = () =>
    isToken
      ? contractsPromise
          .then(({ assetContract }) => assetContract.options.address)
          .then(
            pTap(function (address) {
              debug('%s deposit asset address is %s (%s)', name, address, asset)
            })
          )
      : Promise.reject(new Error('Pool asset is ETH, not an ERC20 token'))

  // Gets the value locked in the pool in deposit assets.
  const getTotalValue = function (defaultBlock) {
    debug('Getting %s total value', name)
    return contractsPromise
      .then(({ poolContract }) =>
        poolContract.methods.totalValue().call({}, defaultBlock)
      )
      .then(
        pTap(function (totalValue) {
          debug(
            'Total value of %s is %s',
            name,
            fromUnit(totalValue, assetDecimals)
          )
        })
      )
  }

  // Gets the total debt of the pool in deposit assets. This only works for
  // pools version 3.
  const getTotalDebt = function (defaultBlock) {
    debug('Getting %s total debt', name)
    return contractsPromise
      .then(({ poolContract }) =>
        poolContract.methods.totalDebt().call({}, defaultBlock)
      )
      .then(
        pTap(function (totalDebt) {
          debug(
            'Total debt of %s is %s',
            name,
            fromUnit(totalDebt, assetDecimals)
          )
        })
      )
  }

  // Gets the value of a pool token in deposit assets.
  const getTokenValue = function (defaultBlock) {
    debug('Getting %s token value', name)
    return contractsPromise
      .then(({ poolContract }) =>
        Promise.all([
          poolContract.methods.totalSupply().call({}, defaultBlock),
          getTotalValue(defaultBlock)
        ])
      )
      .then(([totalSupply, totalValue]) =>
        Big(totalSupply).gt(0)
          ? toUnit(Big(totalValue).div(totalSupply).toFixed())
          : toUnit('1', assetDecimals)
      )
      .then(
        pTap(function (value) {
          debug(
            '%s token value is %s %s',
            name,
            fromUnit(value, assetDecimals),
            asset
          )
        })
      )
  }

  // Gets the internal version of pool contract.
  const getPoolVersion = function () {
    return version === 1
      ? Promise.resolve('2.x')
      : contractsPromise.then(({ poolContract }) =>
          poolContract.methods.VERSION().call()
        )
  }

  // Gets the address of the strategy contract. This works only for v1 pools.
  const getStrategyAddress = function (defaultBlock) {
    debug('Getting %s strategy contract address', name)

    return version === 1
      ? contractsPromise
          .then(({ controllerContracts: { controller } }) =>
            controller.methods.strategy(poolAddress).call({}, defaultBlock)
          )
          .then(
            pTap(function (strategyAddress) {
              debug('%s strategy contract address is %s', name, strategyAddress)
            })
          )
      : Promise.reject(new Error(`Cannot get strategy of ${name} v${version}`))
  }

  // Gets the addresses of the strategy contracts. For v1 pools, it falls back
  // to a compatible more returning the single strategy in a 1-element array.
  const getStrategyAddresses = function (defaultBlock) {
    debug('Getting %s strategy contracts addresses', name)

    return version === 1
      ? getStrategyAddress(defaultBlock).then(address => [address])
      : contractsPromise
          .then(({ poolContract }) =>
            poolContract.methods
              .getStrategies()
              .call({}, defaultBlock)
              .catch(function (err) {
                debug('Could not get strategies of %s: %s', name, err.message)
                debug('Falling back to legacy')
                return promiseLoop(i =>
                  poolContract.methods.strategies(i).call({}, defaultBlock)
                )
              })
          )
          .then(
            pTap(function (strategyAddresses) {
              debug(
                '%s strategy contracts addresses are %s',
                name,
                strategyAddresses.join(', ')
              )
            })
          )
  }

  // Instantiate a strategy contract depending on the pool version.
  const getStrategyContract = function (address) {
    if (address === ZERO_ADDRESS) {
      throw new Error('No strategy contract found')
    }

    return new web3.eth.Contract(
      version === 1 ? strategyAbi : strategyV3Abi,
      address
    )
  }

  // Gets the Maker vault info of the strategy (if applicable).
  const getStrategyVaultInfo = function (strategyAddress, defaultBlock) {
    debug('Getting %s strategy vault number', name)

    const strategy = getStrategyContract(strategyAddress)
    return Promise.resolve()
      .then(() =>
        Promise.all([
          strategy.methods.highWater().call({}, defaultBlock),
          strategy.methods.lowWater().call({}, defaultBlock),
          strategy.methods.isUnderwater().call({}, defaultBlock),
          strategy.methods.vaultNum().call({}, defaultBlock),
          contractsPromise
        ])
      )
      .then(
        pTap(function ([, , vaultNum]) {
          debug('%s strategy vault number is %s', name, vaultNum)
        })
      )
      .then(function ([
        highWater,
        lowWater,
        isUnderwater,
        vaultNum,
        {
          controllerContracts: { collateralManager }
        }
      ]) {
        return Promise.all([
          highWater,
          lowWater,
          isUnderwater,
          vaultNum,
          collateralManager.methods
            .getVaultInfo(vaultNum)
            .call({}, defaultBlock)
        ])
      })
      .then(
        ([
          highWater,
          lowWater,
          isUnderwater,
          vaultNum,
          { collateralRatio, daiDebt }
        ]) => ({
          collateralRatio,
          daiDebt,
          highWater,
          isUnderwater,
          lowWater,
          vaultNum
        })
      )
      .catch(function (err) {
        debug('Could not get %s strategy vault number: %s', name, err.message)
        debug('Assuming non-Maker strategy')
        throw err
      })
  }

  // Gets the interest earned querying the Maker vault and Uniswap.
  const getLegacyInterestEarned = function (defaultBlock) {
    debug('Getting %s interest earned "the legacy way"', name)

    const aDaiAddress = tokens.find(token => token.symbol === 'aDAI').address
    const aDai = new web3.eth.Contract(erc20Abi, aDaiAddress)

    return Promise.all([
      aDai.methods.balanceOf(poolAddress).call({}, defaultBlock),
      getStrategyAddress(defaultBlock).then(strategyAddress =>
        getStrategyVaultInfo(strategyAddress, defaultBlock)
      )
    ])
      .then(function ([aDaiBalance, { daiDebt }]) {
        const unrealizedDai = Big(aDaiBalance).minus(daiDebt).toFixed()
        debug('%s unrealized gains are %s DAI', name, fromUnit(unrealizedDai))
        return uniswapRouter.getAmountOut(
          unrealizedDai,
          ['DAI', isToken ? asset : 'WETH'],
          defaultBlock
        )
      })
      .then(
        pTap(function () {
          debug('Got %s interest earned by the legacy method', name)
        })
      )
  }

  // Gets the total value locked across all the strategies and returns the sum.
  const getStrategiesTotalValue = function (defaultBlock) {
    debug('Getting %s total value across strategies', name)
    return (
      getStrategyAddresses(defaultBlock)
        .then(addresses =>
          Promise.all(
            addresses
              .map(getStrategyContract)
              .map(strategy =>
                strategy.methods.totalValue().call({}, defaultBlock)
              )
          )
        )
        // .then(
        //   pTap(function (totals) {
        //     debug(
        //       'Total value of %s strategies are %s %s',
        //       name,
        //       totals.map(total => fromUnit(total, assetDecimals)).join(', '),
        //       asset
        //     )
        //   })
        // )
        .then(totals =>
          totals.reduce((all, total) => Big(all).plus(total), Big(0)).toFixed()
        )
        .then(
          pTap(function (total) {
            debug(
              'Total value across %s strategies is %s %s',
              name,
              fromUnit(total, assetDecimals),
              asset
            )
          })
        )
    )
  }

  // Gets the name and version of the given strategy contract.
  const getStrategyInfo = function (strategyAddress) {
    const strategy = getStrategyContract(strategyAddress)
    return Promise.all([
      strategy.methods
        .NAME()
        .call()
        .catch(() => 'Unset'),
      strategy.methods
        .VERSION()
        .call()
        .catch(() => 'Unset')
    ]).then(info => info.join(':'))
  }

  // Gets the interest earned in deposit asset since the last rebalance.
  //
  // If the pool is v3, the interst earned is computed by cycling through all
  // the strategies, getting their total values and subtracting the total value
  // of the pool itself.
  const getInterestEarned = function (defaultBlock) {
    debug('Getting %s interest earned', name)

    return (version === 1
      ? getStrategyAddress(defaultBlock)
          .then(getStrategyContract)
          .then(strategy =>
            strategy.methods.interestEarned().call({}, defaultBlock)
          )
          .catch(function (err) {
            debug('Could not get %s interest earned: %s', name, err.message)
            debug('Falling back to legacy method')
            return getLegacyInterestEarned(defaultBlock)
          })
          .catch(function (err) {
            debug(
              'Could not get %s legacy interest earned: %s',
              name,
              err.message
            )
            debug('Assuming %s interest earned is 0.', name)
            return '0'
          })
          .then(function (interestEarned) {
            if (!interestEarned) {
              debug('Could not get %s interest earned: undefined', name)
              debug('Assuming %s interest earned is 0.', name)
              return '0'
            }
            return interestEarned
          })
      : Promise.all([
          getStrategiesTotalValue(defaultBlock),
          getTotalDebt(defaultBlock)
        ]).then(([strategiesTotalValue, totalDebt]) =>
          Big(strategiesTotalValue).minus(totalDebt).toFixed()
        )
    ).then(
      pTap(function (interestEarned) {
        debug(
          '%s interest earned is %s %s',
          name,
          fromUnit(interestEarned, assetDecimals),
          asset
        )
      })
    )
  }

  // Gets the user's balance of pool tokens.
  const getBalance = function (address, defaultBlock) {
    const _address = address || from
    debug('Getting %s balance of %s', name, _address)

    return contractsPromise
      .then(({ poolContract }) =>
        poolContract.methods.balanceOf(_address).call({}, defaultBlock)
      )
      .then(
        pTap(function (balance) {
          debug('Balance of %s is %s %s', _address, fromUnit(balance), name)
        })
      )
  }

  // Gets the user's balance of deposit assets.
  const getAssetBalance = function (address, defaultBlock) {
    const _address = address || from
    debug('Getting %s balance of %s', asset, _address)

    return (isToken
      ? contractsPromise.then(({ assetContract }) =>
          assetContract.methods.balanceOf(_address).call({}, defaultBlock)
        )
      : web3.eth.getBalance(_address)
    ).then(
      pTap(function (balance) {
        debug(
          'Balance of %s is %s %s',
          _address,
          fromUnit(balance, assetDecimals),
          asset
        )
      })
    )
  }

  // Gets the address of the PoolRewards contract.
  const getPoolRewardsAddress = function (defaultBlock) {
    debug('Getting PoolRewards contract address of %s', name)

    return contractsPromise
      .then(({ controllerContracts: { controller } }) =>
        controller.methods.poolRewards(poolAddress).call({}, defaultBlock)
      )
      .then(
        pTap(function (address) {
          debug('PoolRewards contract address of %s is %s', name, address)
        })
      )
  }

  // Instantiate a PoolRewards contract.
  const getPoolRewardsContract = function (address) {
    if (address === ZERO_ADDRESS) {
      throw new Error('No rewards contract found')
    }

    return new web3.eth.Contract(poolRewardsAbi, address)
  }

  // Gets the balance of claimable VSP.
  const getClaimableVsp = function (address, defaultBlock) {
    const _address = address || from
    debug('Getting claimable rewards of %s', _address)

    return getPoolRewardsAddress()
      .then(getPoolRewardsContract)
      .then(poolRewards =>
        Promise.all([
          poolRewards.methods.claimable(_address).call({}, defaultBlock),
          poolRewards.methods.rewardToken().call({}, defaultBlock)
        ])
      )
      .then(([balance, token]) => (token === vspAddress ? balance : '0'))
      .then(
        pTap(function (balance) {
          debug(
            'Claimable rewards of %s in %s is %s VSP',
            _address,
            name,
            fromUnit(balance)
          )
        })
      )
      .catch(function (err) {
        debug('Could not get claimable rewards in %s: %s', name, err.message)
        debug('Assuming claimable rewards in %s is 0 VSP', name)
        return '0'
      })
  }

  // Gets the user's balance of pool tokens in deposit asset.
  const getDepositedBalance = function (address) {
    const _address = address || from
    debug('Getting deposited %s amount', asset)

    return Promise.all([getBalance(_address), getTokenValue()])
      .then(([balance, value]) =>
        Big(fromUnit(Big(balance).times(value).toFixed())).toFixed(0)
      )
      .then(
        pTap(function (balance) {
          debug(
            'Balance of %s is %s %s',
            _address,
            fromUnit(balance, assetDecimals),
            asset
          )
        })
      )
  }

  // Gets the total supply of pool tokens.
  const getTotalSupply = function (defaultBlock) {
    debug('Getting %s total supply', name)

    return contractsPromise
      .then(({ poolContract }) =>
        poolContract.methods.totalSupply().call({}, defaultBlock)
      )
      .then(
        pTap(function (totalSupply) {
          debug('%s total supply is %s', name, fromUnit(totalSupply))
        })
      )
  }

  // Checks if the address is in the no-withdraw-fee list of the pool.
  const isAddressWhitelisted = function (address) {
    debug('Checking if %s is whitelisted for %s', address, name)

    return contractsPromise
      .then(({ poolContract }) =>
        version === 1
          ? poolContract.methods.feeWhiteList().call({})
          : poolContract.methods.feeWhitelist().call({})
      )
      .then(
        pTap(function (feeWhitelistAddress) {
          debug('%s fee whitelist address is %s', name, feeWhitelistAddress)
        })
      )
      .then(feeWhitelistAddress =>
        new web3.eth.Contract(addressListAbi, feeWhitelistAddress).methods
          .contains(address)
          .call()
      )
      .then(
        pTap(function (isWhitelisted) {
          debug(`${address} is${isWhitelisted ? ' ' : ' not'} whitelisted`)
        })
      )
  }

  // Gets the withdraw fee.
  const getWithdrawFee = function (defaultBlock) {
    debug('Getting %s withdraw fee', name)

    return contractsPromise
      .then(({ poolContract }) =>
        poolContract.methods.withdrawFee().call({}, defaultBlock)
      )
      .then(withdrawFee =>
        Big(fromUnit(withdrawFee, version === 1 ? 18 : 4)).toNumber()
      )
      .then(
        pTap(function (withdrawFee) {
          debug('%s withdraw fee is %s%', name, withdrawFee * 100)
        })
      )
  }

  // Gets the interest fee.
  const getInterestFee = function (defaultBlock) {
    debug('Getting %s interest fee', name)

    return contractsPromise
      .then(({ controllerContracts: { controller } }) =>
        controller.methods.interestFee(poolAddress).call({}, defaultBlock)
      )
      .then(interestFee => Big(fromUnit(interestFee)).toNumber())
      .then(
        pTap(function (interestFee) {
          debug('%s interest fee is %s%', name, interestFee * 100)
        })
      )
  }

  // Checks if the pool can be rebalanced.
  // TODO For MakerDAO strategies: tokens (in USD) / high water (3) >= 100 USD
  const canRebalance = (address, defaultBlock) =>
    (version === 1
      ? contractsPromise
          .then(({ poolContract }) =>
            Promise.all([
              poolContract,
              poolContract.methods.tokensHere().call({}, defaultBlock)
            ])
          )
          .then(
            pTap(function ([, amount]) {
              debug(
                '%s pool has %s %s',
                name,
                fromUnit(amount, assetDecimals),
                name
              )
            })
          )
          .then(([poolContract, amount]) => [poolContract, Big(amount).gt(0)])
          .then(function ([poolContract, _canRebalance]) {
            if (!_canRebalance) {
              return false
            }
            debug('Testing rebalance call by estimating gas')
            return poolContract.methods
              .rebalance()
              .estimateGas({ from: address || from })
              .catch(function (err) {
                debug('Rebalance gas etimation failed: %s', err.message)
                return false
              })
          })
      : Promise.resolve(false)
    ).then(
      pTap(function (_canRebalance) {
        debug(
          '%s pool %s be rebalanced',
          name,
          _canRebalance ? 'can' : 'cannot'
        )
      })
    )

  // Checks if the pool grants VSP rewards.
  const hasVspRewards = function (defaultBlock) {
    debug('Checking if %s grants VSP rewards', name)

    return Promise.resolve(
      vspRewards ||
        getPoolRewardsAddress(defaultBlock).then(
          address =>
            address !== ZERO_ADDRESS &&
            getPoolRewardsContract(address)
              .methods.rewardToken()
              .call({}, defaultBlock)
              .then(token => token === vspAddress)
        )
    ).then(
      pTap(function (flag) {
        debug('%s %sgrants VSP rewards', name, flag ? '' : 'does not ')
      })
    )
  }

  // Gets the VSP rewards rate in VSP/sec.
  const getVspRewardsRate = function (defaultBlock) {
    debug('Getting %s rewards rate', name)

    return getPoolRewardsAddress(defaultBlock)
      .then(getPoolRewardsContract)
      .then(poolRewards =>
        Promise.all([
          poolRewards.methods.rewardRate().call({}, defaultBlock),
          poolRewards.methods.rewardToken().call({}, defaultBlock)
        ])
      )
      .then(([rate, token]) => (token === vspAddress ? rate : '0'))
      .catch(function (err) {
        debug('Could not get %s rewards rate:', name, err.message)
        return '0'
      })
      .then(
        pTap(function (rate) {
          debug('%s rewards rate is %s VSP/s', name, fromUnit(rate))
        })
      )
  }

  // Gets the value locked in the pool in USDC.
  const getValueLocked = function (defaultBlock) {
    debug('Getting %s value locked', name)

    return getTotalValue(defaultBlock)
      .then(function (totalValue) {
        const oneAsset = Big(10).pow(Number.parseInt(assetDecimals)).toFixed(0)
        return Promise.all([
          totalValue,
          asset === 'USDC'
            ? oneAsset
            : uniswapRouter.getAmountOut(
                oneAsset,
                isToken
                  ? asset === 'VSP'
                    ? ['VSP', 'WETH', 'USDC']
                    : [asset, 'USDC']
                  : ['WETH', 'USDC'],
                defaultBlock
              ),
          oneAsset
        ])
      })
      .then(([totalValue, rate, oneAsset]) =>
        Big(totalValue).mul(rate).div(oneAsset).toFixed(0)
      )
      .then(
        pTap(function (valueLocked) {
          debug('%s value locked is %s USDC', name, fromUnit(valueLocked, 6))
        })
      )
  }

  // Gets the time in ms until the withdraw lock will expire for the user. Zero
  // means unlocked. This is only applicable to the vVSP pool.
  const getWithdrawTimelock = function (address) {
    if (name !== 'vVSP') {
      debug('Withdraw timelock is not applicable for %s', name)
      return Promise.resolve(0)
    }

    debug('Getting vVSP withdraw timelock status')

    const _address = address || from

    return contractsPromise
      .then(({ poolContract }) =>
        Promise.all([
          poolContract.methods
            .depositTimestamp(_address)
            .call()
            .then(Number.parseInt),
          poolContract.methods.lockPeriod().call().then(Number.parseInt)
        ])
      )
      .then(function ([depositTimestamp, lockPeriod]) {
        if (!depositTimestamp) {
          return 0
        }
        const unlockTime = (depositTimestamp + lockPeriod) * 1000
        return unlockTime > Date.now() ? unlockTime : 0
      })
      .then(
        pTap(function (timelockExpiration) {
          debug(
            'vVSP withdraw is %s',
            timelockExpiration
              ? `locked until ${new Date(timelockExpiration).toISOString()}`
              : 'unlocked'
          )
        })
      )
  }

  // Gets the maximum amount of deposit assets that can withdrawn.
  // For pools investing in Aave v1, this is limited by Aave's liquidity.
  const getMaxWithdrawAmount = function () {
    debug("Getting user's maximum withdraw amount from %s", name)

    return (
      getStrategyAddress()
        .then(getStrategyContract)
        .then(strategy => strategy.methods.AAVE_ADDRESSES_PROVIDER().call())
        // Check it is Aave v1 LendingPoolAddressesProvider.
        // See: https://docs.aave.com/developers/v/1.0/deployed-contracts/deployed-contract-instances
        .then(function (address) {
          if (address !== '0x24a42fD28C976A61Df5D00D0599C34c4f90748c8') {
            throw new Error('Not Aave v1 strategy')
          }
        })
        .then(getAssetAddress)
        // Directly use the Aave v1 LendingPool address and save a few calls.
        .then(assetAddress =>
          new web3.eth.Contract(
            aaveLendingPoolAbi,
            '0x398eC7346DcD622eDc5ae82352F02bE94C62d119'
          ).methods
            .getReserveData(assetAddress)
            .call()
        )
        .then(({ availableLiquidity }) => availableLiquidity)
        .then(
          pTap(function (availableLiquidity) {
            debug(
              'Aave v1 liquidity is %s %s',
              fromUnit(availableLiquidity, assetDecimals),
              asset
            )
          })
        )
        .catch(function (err) {
          debug('Could not get Aave v1 liquidity for %s: %s', name, err.message)
          debug('Assuming the whole balance can be withdrawn')
          return null
        })
        .then(max => Promise.all([max, getDepositedBalance()]))
        .then(([max, balance]) => (max && Big(max).lt(balance) ? max : balance))
        .then(
          pTap(function (amount) {
            debug(
              "User's maximum withdraw amount from %s is %s %s",
              name,
              fromUnit(amount, assetDecimals),
              asset
            )
          })
        )
    )
  }

  // Checks if an approval is needed to transfer the given amount. Unless
  // specified, the deposit asset contract is queried. But the pool itself can
  // also be queried if needed.
  const isApprovalNeeded = function (owner, spender, amount, forPool) {
    const decimals = forPool ? 18 : assetDecimals

    debug(
      'Checking if approval for %s %s is needed',
      fromUnit(amount, decimals),
      forPool ? name : asset
    )

    return (isToken
      ? contractsPromise.then(({ assetContract, poolContract }) =>
          (forPool ? poolContract : assetContract).methods
            .allowance(owner, spender)
            .call()
            .then(
              pTap(function (allowance) {
                debug(
                  'Allowance is %s %s',
                  fromUnit(allowance, decimals),
                  asset
                )
              })
            )
            .then(allowance => Big(allowance).lt(amount))
        )
      : Promise.resolve(false)
    ).then(
      pTap(function (isNeeded) {
        debug('Approval is %s', isNeeded ? 'needed' : 'not needed')
      })
    )
  }

  // Asks the user to sign an ERC-2612 permit.
  // This method only works when interacting with a provider capable of signing
  // typed data i.e. MetaMask or other wallets. If the message is sent to a
  // public Ethereum node, it will fail as the node does not hold the signing
  // keys of the user, of course.
  const signPermit = function (spender, amount, deadline) {
    debug('Signing permit for %s %s', fromUnit(amount), name)

    return (
      contractsPromise
        .then(({ poolContract }) =>
          Promise.all([
            poolContract.methods.name().call(),
            poolContract.meta.chainId,
            poolContract.methods.nonces(from).call()
          ])
        )
        .then(
          pTap(function ([poolName, chainId, nonce]) {
            debug(
              'Building signature for %s at %s with nonce %s',
              poolName,
              chainId,
              nonce
            )
          })
        )
        .then(([poolName, chainId, nonce]) =>
          eip1193.patch(web3.currentProvider).request({
            method: 'eth_signTypedData_v4',
            params: [
              from,
              JSON.stringify({
                types: {
                  EIP712Domain: [
                    { name: 'name', type: 'string' },
                    { name: 'version', type: 'string' },
                    { name: 'chainId', type: 'uint256' },
                    { name: 'verifyingContract', type: 'address' }
                  ],
                  Permit: [
                    { name: 'owner', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' }
                  ]
                },
                domain: {
                  name: poolName,
                  version: '1',
                  chainId,
                  verifyingContract: poolAddress
                },
                // The message to sign is a Permit having allowance data:
                // spender and amount. The nonce is the the one got from the
                // contract and the deadline is T+15m unless specified
                // otherwhise.
                primaryType: 'Permit',
                message: {
                  owner: from,
                  spender,
                  value: amount,
                  nonce,
                  deadline
                }
              })
            ]
          })
        )
        // Split the signature into its r, s and v components.
        .then(result => ({
          r: result.slice(0, 66),
          s: `0x${result.slice(66, 130)}`,
          v: Number(`0x${result.slice(130, 132)}`)
        }))
        .then(
          pTap(function () {
            debug('Permit signed for %s %s', fromUnit(amount), name)
          })
        )
    )
  }

  // Returns a proxy to a method call that needs a permit. The proxy returned
  // has estimateGas and send props.
  //
  // Before estimating the gas, a permit signature is required and the signature
  // is recorded. Then the actual method call is build and the proper
  // estimateGas function is called. When it is time to send the transaction,
  // the recorded signature is used again to build the method call again and
  // execute its send method.
  const createProxyMethodCall = function (spender, amount, buildMethodCall) {
    const deadline = Math.round(Date.now() / 1000) + 900 // T + 15 minutes

    let recordedSignature = {}

    return {
      estimateGas: (...args) =>
        signPermit(spender, amount, deadline).then(function (signature) {
          recordedSignature = signature
          return buildMethodCall(deadline, signature).estimateGas(...args)
        }),
      send: (...args) =>
        buildMethodCall(deadline, recordedSignature).send(...args)
    }
  }

  const executeTransactions = createExecutor({
    from,
    web3,
    overestimation
  })

  // Deposits assets in the pool and receives pool tokens.
  const deposit = function (amount, transactionOptions = {}) {
    debug(
      'Initiating deposit of %s %s into %s',
      fromUnit(amount, assetDecimals),
      asset,
      name
    )

    const _from = transactionOptions.from || from

    // The deposit operation may require an approval if the user is trying to
    // deposit a token and the current allowance is lower than the amount to
    // deposit. Once the approval is queued, if needed, then the deposit
    // transaction is queued up.
    //
    // There is a catch for vETH: it deposits ETH, not ERC-20 tokens. Therefore
    // allowance is not required and the deposit method need to be changed.
    const transactionsPromise = contractsPromise
      .then(({ assetContract, poolContract }) =>
        Promise.all([
          poolContract,
          assetContract,
          isApprovalNeeded(_from, poolAddress, amount)
        ])
      )
      .then(function ([poolContract, assetContract, approvalNeeded]) {
        const txs = []
        if (approvalNeeded) {
          txs.push({
            method: assetContract.methods.approve(poolAddress, amount),
            suffix: 'approve',
            gas: expectedGasFor.approval
          })
        }
        txs.push(
          isToken
            ? {
                method: poolContract.methods.deposit(amount),
                suffix: 'deposit',
                gas: expectedGasFor.deposit
              }
            : {
                method: poolContract.methods.deposit(),
                value: amount,
                suffix: 'deposit',
                gas: expectedGasFor.deposit
              }
        )

        return txs
      })

    const parseResults = function (transactionsData) {
      const sent = amount
      // The two deposit() calls emit different events.
      // See bloqpriv/vesper-pools#114.
      const received = isToken
        ? findReturnValue(
            transactionsData[transactionsData.length - 1].receipt,
            'Deposit',
            'shares',
            poolAddress
          )
        : findReturnValue(
            transactionsData[transactionsData.length - 1].receipt,
            'Transfer',
            'value',
            poolAddress
          )

      debug(
        'Deposit of %s %s into %s completed',
        fromUnit(amount, assetDecimals),
        asset,
        name
      )
      debug('Received %s %s', fromUnit(received), name)

      return { sent, received, decimals: 18 }
    }

    return executeTransactions(
      transactionsPromise,
      parseResults,
      transactionOptions
    )
  }

  // During withdraw operations, the token amount to withdraw may be too close
  // but not be the exact user's balance due to rouding issues. If this is the
  // case, assume the desired amount is the balance and not the given amount.
  // This prevents small amounts (dust) to remain in the user's balance.
  //
  // By default, if the token amount is above 99.9% of the balance, the whole
  // balance will be returned instead of the given amount.
  const sweepDust = (tokenAmount, limit = 0.999) =>
    getBalance().then(balance =>
      Big(tokenAmount).div(balance).toNumber() > limit ? balance : tokenAmount
    )

  // Withdraws deposit assets from the pool by sending pool tokens back.
  const withdraw = function (amount, transactionOptions) {
    debug(
      'Initiating withdrawal of %s %s from %s',
      fromUnit(amount, assetDecimals),
      asset,
      name
    )

    // The withdraw amount has to be specified in pool tokens but the function
    // receives the amount in deposit assets so a conversion through the value
    // of the pool token is required.
    //
    // Catch for vETH: to receive ETH back instead of WETH, withdrawETH() must
    // be called.
    const transactionsPromise = Promise.all([
      contractsPromise,
      getTokenValue().then(function (tokenValue) {
        const tokenAmount = toUnit(Big(amount).div(tokenValue).toFixed())
        return sweepDust(tokenAmount)
      })
    ]).then(function ([{ poolContract }, tokenAmount]) {
      debug('Sending %s %s', fromUnit(tokenAmount), name)
      return [
        isToken
          ? {
              method: poolContract.methods.withdraw(tokenAmount),
              suffix: 'withdraw',
              gas: expectedGasFor.withdraw
            }
          : {
              method: poolContract.methods.withdrawETH(tokenAmount),
              suffix: 'withdraw',
              gas: expectedGasFor.withdraw
            }
      ]
    })

    const parseResults = function ([transactionData]) {
      const sent = findReturnValue(
        transactionData.receipt,
        'Withdraw',
        'shares',
        poolAddress
      )
      const received = findReturnValue(
        transactionData.receipt,
        'Withdraw',
        'amount',
        poolAddress
      )
      const decimals = assetDecimals

      debug(
        'Withdrawal of %s %s from %s completed',
        fromUnit(amount, assetDecimals),
        asset,
        name
      )
      debug('Sent %s %s', fromUnit(sent), name)
      debug('Received %s %s', fromUnit(received, assetDecimals), asset)

      return { sent, received, decimals }
    }

    return executeTransactions(
      transactionsPromise,
      parseResults,
      transactionOptions
    )
  }

  // Claims all claimable VSP in the pool.
  const claimVsp = function (transactionOptions) {
    debug('Initiating claim of VSP from %s', name)

    const transactionsPromise = getPoolRewardsAddress()
      .then(getPoolRewardsContract)
      .then(poolRewardsContract => [
        {
          method: poolRewardsContract.methods.claimReward(from),
          suffix: 'claim',
          gas: expectedGasFor.claimVsp
        }
      ])

    const parseResults = function ([transactionData]) {
      const received = findReturnValue(
        transactionData.receipt,
        'RewardPaid',
        'reward'
      )

      debug('Claim of VSP from %s completed', name)
      debug('Received %s VSP', fromUnit(received))

      return { received, decimals: 18 }
    }

    return executeTransactions(
      transactionsPromise,
      parseResults,
      transactionOptions
    )
  }

  // Rebalances the pool.
  const rebalance = function (transactionOptions) {
    debug('Initiating rebalance of %s', name)

    const transactionsPromise = contractsPromise.then(({ poolContract }) => [
      {
        method: poolContract.methods.rebalance(),
        suffix: 'rebalance',
        gas: expectedGasFor.rebalance
      }
    ])

    const parseResults = function () {
      debug('Rebalance of %s completed', name)

      return {}
    }

    return executeTransactions(
      transactionsPromise,
      parseResults,
      transactionOptions
    )
  }

  // Migrates the maximum amount of deposited assets to a new pool.
  const migrate = function (transactionOptions = {}) {
    debug('Initiating migration from %s', name)

    const _from = transactionOptions.from || from

    // Gets the pool token amount equivalent to the deposit asset amount.
    const getTokenAmount = _amount =>
      getTokenValue().then(tokenValue =>
        toUnit(Big(_amount).div(tokenValue).toFixed())
      )

    // Gets the amount of pool tokens to migrate from the given deposit amount.
    const getMigrateAmount = () =>
      getMaxWithdrawAmount().then(getTokenAmount).then(sweepDust)

    // Returns a new instance of the VAK contract.
    const getVakContract = () => new web3.eth.Contract(vakAbi, vakAddress)

    // To send the proper transaction, the first step is to check wether an
    // approval is needed so VAK can withdraw user tokens from the pool. If this
    // is needed, then a permit has to be signed and then a migrate-with-permit
    // queued. Otherwhise, a plain migrate must be queued.
    const transactionsPromise = getMigrateAmount()
      .then(function (tokenAmount) {
        debug('Amount to migrate is %s %s', fromUnit(tokenAmount), name)

        return Promise.all([
          tokenAmount,
          isApprovalNeeded(_from, vakAddress, tokenAmount, true)
        ])
      })
      .then(([tokenAmount, approvalNeeded]) =>
        approvalNeeded
          ? [
              {
                method: createProxyMethodCall(
                  vakAddress,
                  tokenAmount,
                  (deadline, { v, r, s }) =>
                    getVakContract().methods.simpleMigrateWithPermit(
                      poolAddress,
                      supersededBy,
                      _from,
                      vakAddress,
                      tokenAmount,
                      deadline,
                      v,
                      r,
                      s
                    )
                ),
                suffix: 'migrate',
                gas: expectedGasFor.approval + expectedGasFor.migrate
              }
            ]
          : [
              {
                method: getVakContract().methods.simpleMigrate(
                  poolAddress,
                  supersededBy,
                  tokenAmount
                ),
                suffix: 'migrate',
                gas: expectedGasFor.migrate
              }
            ]
      )

    const parseResults = function ([transactionData]) {
      parseReceiptEvents(poolAbi, poolAddress, transactionData.receipt)
      parseReceiptEvents(poolAbi, supersededBy, transactionData.receipt)

      const sent = findReturnValue(
        transactionData.receipt,
        'Withdraw',
        'shares',
        poolAddress
      )
      const received = findReturnValue(
        transactionData.receipt,
        'Deposit',
        'shares',
        supersededBy
      )

      debug('Migration of %s %s completed', fromUnit(sent), name)
      debug('Received %s at pool %s', fromUnit(received), supersededBy)

      return { sent, received, decimals: 18 }
    }

    return executeTransactions(
      transactionsPromise,
      parseResults,
      transactionOptions
    )
  }

  // Approves and deposits assets in the pool.
  const approveAndDeposit = function (
    approveAmount,
    depositAmount,
    transactionOptions = {}
  ) {
    debug(
      'Initiating approval of %s and deposit of %s %s into %s',
      fromUnit(approveAmount, assetDecimals),
      fromUnit(depositAmount, assetDecimals),
      asset,
      name
    )

    // There is a catch for vETH: it deposits ETH, not ERC-20 tokens. Therefore
    // the deposit method need to be changed.
    const transactionsPromise = contractsPromise
      .then(({ assetContract, poolContract }) =>
        Promise.all([poolContract, assetContract])
      )
      .then(function ([poolContract, assetContract]) {
        const txs = []
        txs.push({
          method: assetContract.methods.approve(poolAddress, approveAmount),
          suffix: 'approve',
          gas: expectedGasFor.approval
        })
        txs.push(
          isToken
            ? {
                method: poolContract.methods.deposit(depositAmount),
                suffix: 'deposit',
                gas: expectedGasFor.deposit
              }
            : {
                method: poolContract.methods.deposit(),
                value: depositAmount,
                suffix: 'deposit',
                gas: expectedGasFor.deposit
              }
        )

        return txs
      })

    const parseResults = function (transactionsData) {
      const sent = depositAmount
      // The two deposit() calls emit different events.
      // See bloqpriv/vesper-pools#114.
      const received = isToken
        ? findReturnValue(
            transactionsData[transactionsData.length - 1].receipt,
            'Deposit',
            'shares',
            poolAddress
          )
        : findReturnValue(
            transactionsData[transactionsData.length - 1].receipt,
            'Transfer',
            'value',
            poolAddress
          )

      debug(
        'Approval of %s and deposit of %s %s into %s completed',
        fromUnit(approveAmount, assetDecimals),
        fromUnit(depositAmount, assetDecimals),
        asset,
        name
      )
      debug('Received %s %s', fromUnit(received), name)

      return { sent, received, decimals: 18 }
    }

    return executeTransactions(
      transactionsPromise,
      parseResults,
      transactionOptions
    )
  }

  // Return the pool contracts.
  const getContracts = () => contractsPromise

  return {
    approveAndDeposit,
    canRebalance,
    claimVsp,
    deposit,
    getAddress,
    getAssetAddress,
    getAssetBalance,
    getBalance,
    getClaimableVsp,
    getContracts,
    getDepositedBalance,
    getInterestEarned,
    getInterestFee,
    getMaxWithdrawAmount,
    getPoolRewardsAddress,
    getPoolVersion,
    getStrategyAddress,
    getStrategyAddresses,
    getStrategyInfo,
    getStrategyVaultInfo,
    getTokenValue,
    getTotalSupply,
    getValueLocked,
    getVspRewardsRate,
    getWithdrawFee,
    getWithdrawTimelock,
    hasVspRewards,
    isAddressWhitelisted,
    isApprovalNeeded,
    migrate,
    rebalance,
    signPermit,
    withdraw
  }
}

module.exports = createPoolMethods
