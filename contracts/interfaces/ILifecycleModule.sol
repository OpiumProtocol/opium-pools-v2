// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

interface ILifecycleModule {
  event EpochStarted(uint256 indexed epochId, uint256 epochStart);

  function getEpochId() external view returns (uint16);
  function getCurrentEpochStart() external view returns (uint256);
  function getCurrentEpochEnd() external view returns (uint256);
  function getEpochLength() external view returns (uint256);
  function getStakingPhaseLength() external view returns (uint256);
  function getTradingPhaseLength() external view returns (uint256);
  function isStakingPhase() external view returns (bool);
  function isTradingPhase() external view returns (bool);
  function isIdlePhase() external view returns (bool);
  function canDeposit() external view returns (bool);
  function canWithdraw() external view returns (bool);
  function canTrade() external view returns (bool);
  function canRebalance() external view returns (bool);

  function progressEpoch() external;
}
