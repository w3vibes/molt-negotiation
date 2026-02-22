// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { MoltNegotiationEscrow } from "../src/MoltNegotiationEscrow.sol";

contract MoltNegotiationEscrowTest is Test {
    MoltNegotiationEscrow escrow;

    bytes32 internal sessionId = bytes32(uint256(1));
    address internal proposer = address(0x1);
    address internal counterparty = address(0x2);

    function setUp() public {
        escrow = new MoltNegotiationEscrow();
    }

    function test_prepare() public {
        escrow.prepare(sessionId, proposer, counterparty, 1_000);
        (
            MoltNegotiationEscrow.Status status,
            address p,
            address c,
            uint256 stakeAmount,
            uint256 pd,
            uint256 cd,
            address winner
        ) = escrow.getSession(sessionId);

        assertEq(uint8(status), uint8(MoltNegotiationEscrow.Status.Prepared));
        assertEq(p, proposer);
        assertEq(c, counterparty);
        assertEq(stakeAmount, 1_000);
        assertEq(pd, 0);
        assertEq(cd, 0);
        assertEq(winner, address(0));
    }

    function test_deposit_requires_full_stake_to_be_funded() public {
        escrow.prepare(sessionId, proposer, counterparty, 1_000);

        vm.prank(proposer);
        escrow.deposit(sessionId, 400);
        vm.prank(counterparty);
        escrow.deposit(sessionId, 600);

        (MoltNegotiationEscrow.Status status,,,,,,) = escrow.getSession(sessionId);
        assertEq(uint8(status), uint8(MoltNegotiationEscrow.Status.Prepared));

        vm.prank(proposer);
        escrow.deposit(sessionId, 600);
        vm.prank(counterparty);
        escrow.deposit(sessionId, 400);

        (status,,,,,,) = escrow.getSession(sessionId);
        assertEq(uint8(status), uint8(MoltNegotiationEscrow.Status.Funded));
        assertTrue(escrow.isFunded(sessionId));
    }

    function test_settle() public {
        escrow.prepare(sessionId, proposer, counterparty, 1_000);

        vm.prank(proposer);
        escrow.deposit(sessionId, 1_000);
        vm.prank(counterparty);
        escrow.deposit(sessionId, 1_000);

        escrow.settle(sessionId, proposer, '{"outcome":"accepted"}');

        (MoltNegotiationEscrow.Status status,,,,,, address winner) = escrow.getSession(sessionId);
        assertEq(uint8(status), uint8(MoltNegotiationEscrow.Status.Settled));
        assertEq(winner, proposer);
    }

    function test_refund() public {
        escrow.prepare(sessionId, proposer, counterparty, 1_000);

        vm.prank(proposer);
        escrow.deposit(sessionId, 500);

        escrow.refund(sessionId);

        (MoltNegotiationEscrow.Status status,,,, uint256 pd, uint256 cd,) = escrow.getSession(sessionId);
        assertEq(uint8(status), uint8(MoltNegotiationEscrow.Status.Refunded));
        assertEq(pd, 500);
        assertEq(cd, 0);
    }

    function test_double_settle_rejected() public {
        escrow.prepare(sessionId, proposer, counterparty, 1_000);

        vm.prank(proposer);
        escrow.deposit(sessionId, 1_000);
        vm.prank(counterparty);
        escrow.deposit(sessionId, 1_000);

        escrow.settle(sessionId, proposer, '{"outcome":"accepted"}');

        vm.expectRevert("NOT_FUNDED");
        escrow.settle(sessionId, proposer, '{"outcome":"accepted"}');
    }
}
