/** Deployment Template
 *
 * // 1. Check all TODOs to run the deployment properly
 * // 2. Use commented code to use already deployed contract instead of deploying new one
 *
 */

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { upgrades } from "hardhat";
import { AbiCoder } from "ethers/lib/utils";

import {
  GnosisSafeL2,
  GnosisSafeProxyFactory,
  RegistryModule,
  AccountingModule,
  LifecycleModule,
  StakingModule,
  OptionCallSellingStrategy,
} from "../../typechain";

import {
  deployGnosisSafe,
  enableModule,
  setupRegistry,
  setStrategyDerivative,
} from "../../test/mixins";

// TODO: Add all the addresses
// Safe Constants
const GNOSIS_SAFE_MASTER_COPY_ADDRESS = "";
const GNOSIS_SAFE_PROXY_FACTORY_ADDRESS = "";
const GNOSIS_FALLBACK_HANDLER = "";

// Strategy Constants
const GNOSIS_SAFE_SIGN_MESSAGE_LIB_ADDRESS = "";
const OPIUM_REGISTRY_ADDRESS = "";
const OPIUM_LENS_ADDRESS = "";
const AUCTION_HELPER_ADDRESS = "";
const LIMIT_ORDER_PROTOCOL_ADDRESS = "";

// Misc
const WETH_ADDRESS = "";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, network, ethers } = hre;
  const { deploy } = deployments;

  const [deployer] = await ethers.getSigners();

  // Skip if network is not correct
  // TODO: Put a correct network name
  if (network.name !== "name") {
    return;
  }

  /** #1: Deploy GnosisSafe */
  const gnosisSafeSingleton = await ethers.getContractAt<GnosisSafeL2>(
    "GnosisSafeL2",
    GNOSIS_SAFE_MASTER_COPY_ADDRESS
  );

  const gnosisSafeProxyFactory =
    await ethers.getContractAt<GnosisSafeProxyFactory>(
      "GnosisSafeProxyFactory",
      GNOSIS_SAFE_PROXY_FACTORY_ADDRESS
    );

  const gnosisSafe = await deployGnosisSafe(
    gnosisSafeSingleton, // Singleton
    gnosisSafeProxyFactory, // Proxy Factory
    GNOSIS_FALLBACK_HANDLER, // Fallback handler
    deployer // Safe Owner
  );
  // const gnosisSafe = await ethers.getContractAt<GnosisSafeL2>(
  //   "GnosisSafeL2",
  //   ""
  // );
  console.log(`Deployed GnosisSafe @ ${gnosisSafe.address}`);

  /** #2: Deploy Registry */
  const RegistryFactory = await ethers.getContractFactory("RegistryModule");
  const registryInitializerParams = new AbiCoder().encode(
    ["address", "address", "address"],
    [
      gnosisSafe.address, // Owner
      gnosisSafe.address, // Avatar
      gnosisSafe.address, // Target
    ]
  );
  const registryModule = (await upgrades.deployProxy(
    RegistryFactory,
    [registryInitializerParams],
    {
      initializer: "setUp",
    }
  )) as RegistryModule;
  // const registryModule = await ethers.getContractAt<RegistryModule>(
  //   "RegistryModule",
  //   ""
  // );
  console.log(`Deployed RegistryModule @ ${registryModule.address}`);

  /** #3: Deploy AccountingModule */
  const AccountingFactory = await ethers.getContractFactory("AccountingModule");
  const accountingModule = (await upgrades.deployProxy(AccountingFactory, [
    WETH_ADDRESS, // Underlying
    registryModule.address, // Registry
    gnosisSafe.address, // Owner
  ])) as AccountingModule;
  // const accountingModule = await ethers.getContractAt<AccountingModule>(
  //   "AccountingModule",
  //   ""
  // );
  console.log(`Deployed AccountingModule @ ${accountingModule.address}`);

  /** #4: Deploy LifecycleModule */
  const LifecycleFactory = await ethers.getContractFactory("LifecycleModule");
  const epochStart = ~~(Date.now() / 1000);
  const EPOCH_LENGTH = 3600 * 5 + 100;
  const STAKING_LENGTH = 3600 * 3;
  const TRADING_LENGTH = 3600 * 2;
  const lifecycleModule = (await upgrades.deployProxy(LifecycleFactory, [
    epochStart, // Epoch start
    [EPOCH_LENGTH, STAKING_LENGTH, TRADING_LENGTH], // Lengths
    registryModule.address, // Registry
    gnosisSafe.address, // Owner
  ])) as LifecycleModule;
  // const lifecycleModule = await ethers.getContractAt<LifecycleModule>(
  //   "LifecycleModule",
  //   ""
  // );
  console.log(`Deployed LifecycleModule @ ${lifecycleModule.address}`);

  /** #5: Deploy StakingModule */
  const StakingFactory = await ethers.getContractFactory("StakingModule");
  const stakingModule = (await upgrades.deployProxy(StakingFactory, [
    "LP Token", // Name
    "LPT", // Symbol
    registryModule.address, // Registry
    gnosisSafe.address, // Owner
  ])) as StakingModule;
  // const stakingModule = await ethers.getContractAt<StakingModule>(
  //   "StakingModule",
  //   ""
  // );
  console.log(`Deployed StakingModule @ ${stakingModule.address}`);

  /** #6: Deploy StrategyModule */
  const optionCallSellingStrategy = await deploy("OptionCallSellingStrategy", {
    from: deployer.address,
    args: [
      OPIUM_REGISTRY_ADDRESS, // Opium Registry
      OPIUM_LENS_ADDRESS, // Opium Lens
      GNOSIS_SAFE_SIGN_MESSAGE_LIB_ADDRESS, // Gnosis Safe: Sign Helper
      AUCTION_HELPER_ADDRESS, // Auction Helper
      LIMIT_ORDER_PROTOCOL_ADDRESS, // Limit order protocol
      registryModule.address, // Registry
      gnosisSafe.address, // Owner
      deployer.address, // Advisor
    ],
    log: true,
  });
  // const optionCallSellingStrategy =
  //   await ethers.getContractAt<OptionCallSellingStrategy>(
  //     "OptionCallSellingStrategy",
  //     ""
  //   );
  console.log(
    `Deployed OptionCallSellingStrategy @ ${optionCallSellingStrategy.address}`
  );

  /** #7: Enable Registry Module */
  await enableModule(gnosisSafe, registryModule.address, deployer);
  console.log("Registry module enabled");

  /** #8: Setup Registry */
  await setupRegistry(
    gnosisSafe,
    registryModule,
    accountingModule,
    lifecycleModule,
    stakingModule,
    optionCallSellingStrategy.address,
    deployer
  );
  console.log("Registry is set up");

  /** #9: Setup strategy */
  const ONE_ETH = ethers.utils.parseEther("1");
  const SYNTHETIC_ID_ADDRESS = ""; // OPT-C
  const ORACLE_ID_ADDRESS = ""; // ETH/USD
  const STRIKE_PRICE = ethers.utils.parseEther("1400");
  const COLLATERALIZATION = ethers.utils.parseEther("1");

  const derivative = {
    margin: ONE_ETH,
    endTime: await lifecycleModule.getCurrentEpochEnd(),
    params: [STRIKE_PRICE, COLLATERALIZATION, 0],
    syntheticId: SYNTHETIC_ID_ADDRESS,
    token: WETH_ADDRESS,
    oracleId: ORACLE_ID_ADDRESS,
  };
  await setStrategyDerivative(
    gnosisSafe,
    optionCallSellingStrategy as unknown as OptionCallSellingStrategy,
    derivative,
    deployer
  );
  console.log("Strategy derivative is set");

  // TODO: Change to `true` to persist deployment
  return false;
};

export default func;
// TODO: Change to reflect deployment
func.id = "00_TEST";
func.tags = ["OpiumPool", "OptionCallSellingStrategy"];
