# Build Agent - Orchestrator Guide

This document explains the enhanced build agent configuration and how to use subagents effectively.

## Overview

The build agent (`~/.config/opencode/agents/build.md`) is now configured as an **orchestrator** that delegates work to specialized subagents rather than doing most work directly.

## Agent Configuration

### Build Agent (Orchestrator)
- **Mode**: Primary agent
- **Access**: Read-only tools + delegation capability
- **Purpose**: Analyze requests and route to appropriate subagents

### Available Subagents

#### @explore - Codebase Explorer
- **Purpose**: Fast, read-only exploration and analysis
- **Best for**: Finding files, understanding structure, quick lookups
- **Limitations**: Cannot modify files

#### @general - Implementation Specialist  
- **Purpose**: Multi-step implementation and feature development
- **Best for**: Building features, refactoring, parallel work
- **Capabilities**: Full tool access for making changes

#### @plan - Analysis & Planning Expert
- **Purpose**: Deep analysis and strategic planning
- **Best for**: Complex research, architecture decisions, risk assessment
- **Limitations**: Read-only, focuses on analysis over implementation

## Decision Framework

### Start with @explore when:
- Question starts with "Where", "How does", "What files", "Show me"
- Need to understand existing code structure
- Research before making changes
- Quick fact-finding missions

### Use @general when:
- Task involves "Add", "Implement", "Create", "Build", "Refactor"
- Multiple coordinated steps required
- Need to modify or create files
- Complex feature development

### Choose @plan when:
- Request includes "Analyze", "Plan", "Research", "Evaluate"
- Need to understand options before implementing
- Complex problem requiring investigation
- Architecture or design decisions needed

## Example Interactions

**User**: "Find where user authentication is implemented"
**Response**: Delegates to @explore to locate auth files and understand the structure

**User**: "Add two-factor authentication to the login system"  
**Response**: Delegates to @general for implementation (may first use @explore for research)

**User**: "Analyze the current authentication system and suggest security improvements"
**Response**: Delegates to @plan for security analysis and recommendations

## Benefits of This Approach

1. **Specialization**: Each subagent excels at its specific task type
2. **Parallelization**: @general can run multiple work streams simultaneously  
3. **Safety**: @explore and @plan provide safe analysis without side effects
4. **Clarity**: Clear separation between research, planning, and implementation
5. **Efficiency**: Right tool for the job avoids overkill for simple tasks

## Migration Notes

- The build agent no longer directly modifies files
- All implementation work flows through @general
- Use @explore for codebase understanding tasks
- Use @plan for complex analysis requirements
- The orchestrator coordinates handoffs between subagents when needed