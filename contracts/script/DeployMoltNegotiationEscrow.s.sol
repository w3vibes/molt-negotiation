// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {MoltNegotiationEscrow} from "../src/MoltNegotiationEscrow.sol";

contract DeployMoltNegotiationEscrow is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        vm.startBroadcast(deployerPrivateKey);
        
        MoltNegotiationEscrow escrow = new MoltNegotiationEscrow();
        
        vm.stopBroadcast();
        
        console.log("MoltNegotiationEscrow deployed:", address(escrow));
    }
}
