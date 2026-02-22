// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MoltNegotiationEscrow
/// @notice Escrow contract for staked negotiation settlements.
/// @dev Accounting-only escrow scaffold for Phase 5 API integration. Token transfer wiring can be added in deployment-specific versions.
contract MoltNegotiationEscrow {
    event Prepared(bytes32 indexed sessionId, address proposer, address counterparty, uint256 stakeAmount);
    event Deposited(bytes32 indexed sessionId, address depositor, uint256 amount, uint256 totalDeposited);
    event Funded(bytes32 indexed sessionId, uint256 proposerDeposit, uint256 counterpartyDeposit);
    event Settled(bytes32 indexed sessionId, address winner, uint256 amount);
    event Refunded(bytes32 indexed sessionId, uint256 proposerAmount, uint256 counterpartyAmount);

    enum Status {
        None,
        Prepared,
        Funded,
        Settled,
        Refunded
    }

    struct Session {
        Status status;
        address proposer;
        address counterparty;
        uint256 stakeAmount;
        uint256 proposerDeposit;
        uint256 counterpartyDeposit;
        address winner;
    }

    mapping(bytes32 => Session) public sessions;
    mapping(bytes32 => string) public settlementTerms;

    modifier onlyPrepared(bytes32 sessionId) {
        require(sessions[sessionId].status == Status.Prepared, "NOT_PREPARED");
        _;
    }

    modifier onlyFunded(bytes32 sessionId) {
        require(sessions[sessionId].status == Status.Funded, "NOT_FUNDED");
        _;
    }

    modifier onlyExisting(bytes32 sessionId) {
        require(sessions[sessionId].status != Status.None, "SESSION_NOT_FOUND");
        _;
    }

    function prepare(bytes32 sessionId, address proposer, address counterparty, uint256 stakeAmount) external {
        require(sessions[sessionId].status == Status.None, "ALREADY_EXISTS");
        require(proposer != address(0) && counterparty != address(0), "ZERO_ADDRESS");
        require(proposer != counterparty, "DUPLICATE_PARTY");
        require(stakeAmount > 0, "INVALID_STAKE");

        sessions[sessionId] = Session({
            status: Status.Prepared,
            proposer: proposer,
            counterparty: counterparty,
            stakeAmount: stakeAmount,
            proposerDeposit: 0,
            counterpartyDeposit: 0,
            winner: address(0)
        });

        emit Prepared(sessionId, proposer, counterparty, stakeAmount);
    }

    function deposit(bytes32 sessionId, uint256 amount) external onlyPrepared(sessionId) {
        Session storage s = sessions[sessionId];

        require(amount > 0, "INVALID_AMOUNT");
        require(msg.sender == s.proposer || msg.sender == s.counterparty, "NOT_AUTHORIZED");

        if (msg.sender == s.proposer) {
            s.proposerDeposit += amount;
            emit Deposited(sessionId, msg.sender, amount, s.proposerDeposit);
        } else {
            s.counterpartyDeposit += amount;
            emit Deposited(sessionId, msg.sender, amount, s.counterpartyDeposit);
        }

        if (s.proposerDeposit >= s.stakeAmount && s.counterpartyDeposit >= s.stakeAmount) {
            s.status = Status.Funded;
            emit Funded(sessionId, s.proposerDeposit, s.counterpartyDeposit);
        }
    }

    function settle(bytes32 sessionId, address winner, string calldata terms) external onlyFunded(sessionId) {
        Session storage s = sessions[sessionId];
        require(winner == s.proposer || winner == s.counterparty, "INVALID_WINNER");

        s.winner = winner;
        s.status = Status.Settled;
        settlementTerms[sessionId] = terms;

        emit Settled(sessionId, winner, s.proposerDeposit + s.counterpartyDeposit);
    }

    function refund(bytes32 sessionId) external onlyExisting(sessionId) {
        Session storage s = sessions[sessionId];
        require(s.status == Status.Prepared || s.status == Status.Funded, "NOT_REFUNDABLE");

        uint256 proposerAmt = s.proposerDeposit;
        uint256 counterpartyAmt = s.counterpartyDeposit;
        s.status = Status.Refunded;

        emit Refunded(sessionId, proposerAmt, counterpartyAmt);
    }

    function isFunded(bytes32 sessionId) external view returns (bool) {
        Session storage s = sessions[sessionId];
        return s.status == Status.Funded;
    }

    function getSession(bytes32 sessionId)
        external
        view
        returns (
            Status status,
            address proposer,
            address counterparty,
            uint256 stakeAmount,
            uint256 proposerDeposit,
            uint256 counterpartyDeposit,
            address winner
        )
    {
        Session storage s = sessions[sessionId];
        return (s.status, s.proposer, s.counterparty, s.stakeAmount, s.proposerDeposit, s.counterpartyDeposit, s.winner);
    }
}
