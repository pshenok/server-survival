/**
 * PlayModeController - Manages Play mode (Survival only - no sandbox)
 * Extracted from main.html to isolate Play flow
 */
import { BaseModeController } from '../core/BaseModeController.js';

class PlayModeController extends BaseModeController {
    constructor(app) {
        super(app, 'Play');
        this.gameInstance = null;
        this.gameState = null;
    }

    /**
     * Initialize Play mode - force survival mode only
     */
    async initializeMode() {
        // Force mode to Play (survival) - no sandbox
        this.mode = 'PLAY';
        
        // Set up game integration
        this.setupGameIntegration();
    }

    /**
     * Set up game integration
     */
    setupGameIntegration() {
        // Listen for game events
        this.eventSystem.on('game:started', (data) => {
            this.handleGameStarted(data);
        });

        this.eventSystem.on('game:ended', (data) => {
            this.handleGameEnded(data);
        });

        this.eventSystem.on('game:paused', (data) => {
            this.handleGamePaused(data);
        });
    }

    /**
     * Activate Play mode - show options screen first
     */
    async activate(options) {
        // Show main menu modal (options screen)
        const mainMenu = document.getElementById('main-menu-modal');
        if (mainMenu) {
            mainMenu.classList.remove('hidden');
        }

        // Show shared navbar
        if (window.sharedNavbar) {
            window.sharedNavbar.show();
        }

        // Emit activation event
        this.eventSystem.emit('play-mode:activated', { mode: 'PLAY' });
    }

    /**
     * Deactivate Play mode
     */
    async deactivate() {
        // Stop any running game
        if (this.gameInstance) {
            this.stopGame();
        }

        // Show navbar if it was hidden
        if (window.sharedNavbar) {
            window.sharedNavbar.show();
        }

        // Emit deactivation event
        this.eventSystem.emit('play-mode:deactivated');
    }

    /**
     * Start Play mode (survival) - called by startGame()
     */
    async startPlayMode() {
        console.log('PlayModeController: Starting Play mode (survival)');
        
        // Hide navbar during gameplay
        if (window.sharedNavbar) {
            window.sharedNavbar.hide();
        }

        // Hide main menu
        const mainMenu = document.getElementById('main-menu-modal');
        if (mainMenu) {
            mainMenu.classList.add('hidden');
        }

        // Force game mode to survival (Play)
        if (typeof window.resetGame === 'function') {
            window.resetGame('survival');
        }

        // Start tutorial if available
        if (window.tutorial) {
            setTimeout(() => {
                window.tutorial.start();
            }, 500);
        }

        // Emit event
        this.eventSystem.emit('play-mode:started');
    }

    /**
     * Continue Play mode - called by loadGameState()
     */
    async continuePlayMode() {
        console.log('PlayModeController: Continuing Play mode');
        
        // Hide navbar during gameplay
        if (window.sharedNavbar) {
            window.sharedNavbar.hide();
        }

        // Hide main menu
        const mainMenu = document.getElementById('main-menu-modal');
        if (mainMenu) {
            mainMenu.classList.add('hidden');
        }

        // Load game state
        if (typeof window.loadGameState === 'function') {
            window.loadGameState();
        }

        // Emit event
        this.eventSystem.emit('play-mode:continued');
    }

    /**
     * Stop the current game
     */
    stopGame() {
        if (this.gameInstance) {
            // Stop game logic here
            this.gameInstance = null;
        }

        // Show main menu
        const mainMenu = document.getElementById('main-menu-modal');
        if (mainMenu) {
            mainMenu.classList.remove('hidden');
        }

        // Show navbar
        if (window.sharedNavbar) {
            window.sharedNavbar.show();
        }

        // Emit event
        this.eventSystem.emit('play-mode:game-stopped');
    }

    /**
     * Handle game started event
     */
    handleGameStarted(data) {
        this.gameState = 'running';
        this.gameInstance = data.instance;
        
        // Update UI state
        this.setState({ gameState: 'running', gameMode: 'survival' });
    }

    /**
     * Handle game ended event
     */
    handleGameEnded(data) {
        this.gameState = 'ended';
        
        // Show results or return to options screen
        setTimeout(() => {
            this.stopGame();
        }, 2000);
        
        // Update UI state
        this.setState({ gameState: 'ended', results: data.results });
    }

    /**
     * Handle game paused event
     */
    handleGamePaused(data) {
        this.gameState = 'paused';
        
        // Show navbar when paused
        if (window.sharedNavbar) {
            window.sharedNavbar.show();
        }
        
        // Update UI state
        this.setState({ gameState: 'paused' });
    }

    /**
     * Get current state
     */
    getState() {
        return {
            ...super.getState(),
            mode: 'PLAY',
            gameState: this.gameState,
            gameInstance: this.gameInstance ? 'active' : null
        };
    }
}

export { PlayModeController };