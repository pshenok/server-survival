class SoundService {
    constructor() {
        this.ctx = null;
        this.muted = true;
        this.masterGain = null;
        this.gameBgm = new Audio('assets/sounds/game-background.mp3');
        this.gameBgm.loop = true;
        this.gameBgm.volume = 0.2;

        this.menuBgm = new Audio('assets/sounds/menu.mp3');
        this.menuBgm.loop = true;
        this.menuBgm.volume = 0.3;

        this.currentBgm = null;

        this.sfxHover = new Audio('assets/sounds/click-5.mp3');
        this.sfxClick = new Audio('assets/sounds/click-9.mp3');
        this.sfxHover.volume = 0.4;
        this.sfxClick.volume = 0.5;
    }

    init() {
        if (this.ctx) return;
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.3;
        this.masterGain.connect(this.ctx.destination);

        const resumeAudio = () => {
            if (this.ctx.state === 'suspended') this.ctx.resume();

            // Try to play current BGM if set
            if (this.currentBgm && this.currentBgm.paused && !this.muted) {
                this.currentBgm.play().catch(e => console.log("BGM autoplay blocked"));
            }

            // We don't remove the listener immediately because sometimes the first click doesn't fully unlock everything depending on browser
            // But usually one click is enough. Let's keep it simple.
            if (this.ctx.state === 'running') {
                window.removeEventListener('click', resumeAudio);
                window.removeEventListener('keydown', resumeAudio);
            }
        };
        window.addEventListener('click', resumeAudio);
        window.addEventListener('keydown', resumeAudio);
    }

    playMenuBGM() {
        this.switchBGM(this.menuBgm);
    }

    playGameBGM() {
        this.switchBGM(this.gameBgm);
    }

    switchBGM(newBgm) {
        if (this.currentBgm === newBgm) {
            if (this.currentBgm.paused && !this.muted && this.ctx && this.ctx.state === 'running') {
                this.currentBgm.play().catch(e => { });
            }
            return;
        }

        if (this.currentBgm) {
            this.currentBgm.pause();
            this.currentBgm.currentTime = 0;
        }

        this.currentBgm = newBgm;
        if (!this.muted) {
            // If context is running, play immediately. Otherwise it will be picked up by resumeAudio
            if (this.ctx && this.ctx.state === 'running') {
                this.currentBgm.play().catch(e => console.log("Waiting for interaction to play BGM"));
            }
        }
    }

    playMenuHover() {
        if (!this.muted) {
            this.sfxHover.currentTime = 0;
            this.sfxHover.play().catch(() => { });
        }
    }

    playMenuClick() {
        if (!this.muted) {
            this.sfxClick.currentTime = 0;
            this.sfxClick.play().catch(() => { });
        }
    }

    toggleMute() {
        this.muted = !this.muted;
        if (this.masterGain) {
            this.masterGain.gain.value = this.muted ? 0 : 0.3;
        }

        if (this.muted) {
            if (this.currentBgm) this.currentBgm.pause();
        } else {
            if (this.currentBgm) this.currentBgm.play().catch(e => { });
        }

        return this.muted;
    }

    playTone(freq, type, duration, startTime = 0) {
        if (!this.ctx || this.muted) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime + startTime);

        gain.gain.setValueAtTime(1, this.ctx.currentTime + startTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + startTime + duration);

        osc.connect(gain);
        gain.connect(this.masterGain);

        osc.start(this.ctx.currentTime + startTime);
        osc.stop(this.ctx.currentTime + startTime + duration);
    }

    playPlace() { this.playTone(440, 'square', 0.1); }
    playConnect() { this.playTone(880, 'sine', 0.1); }
    playDelete() {
        this.playTone(200, 'sawtooth', 0.2);
        this.playTone(150, 'sawtooth', 0.2, 0.1);
    }
    playSuccess() {
        this.playTone(523.25, 'square', 0.1);
        this.playTone(659.25, 'square', 0.1, 0.1);
    }
    playFail() {
        this.playTone(150, 'sawtooth', 0.3);
    }
    playFraudBlocked() {
        this.playTone(800, 'triangle', 0.05);
        this.playTone(1200, 'triangle', 0.1, 0.05);
    }
    playGameOver() {
        if (!this.ctx || this.muted) return;
        [440, 415, 392, 370].forEach((f, i) => {
            this.playTone(f, 'triangle', 0.4, i * 0.4);
        });
    }
}
