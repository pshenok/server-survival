class SoundService {
    constructor() {
        this.ctx = null;
        this.muted = false;
        this.masterGain = null;
        this.bgm = new Audio('assets/sounds/game-background.mp3');
        this.bgm.loop = true;
        this.bgm.volume = 0.2;
    }

    init() {
        if (this.ctx) return;
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.3;
        this.masterGain.connect(this.ctx.destination);

        this.playBGM();

        const resumeAudio = () => {
            if (this.ctx.state === 'suspended') this.ctx.resume();
            if (this.bgm.paused && !this.muted) this.bgm.play().catch(e => console.log("BGM autoplay blocked"));
            window.removeEventListener('click', resumeAudio);
            window.removeEventListener('keydown', resumeAudio);
        };
        window.addEventListener('click', resumeAudio);
        window.addEventListener('keydown', resumeAudio);
    }

    playBGM() {
        if (this.muted) return;
        this.bgm.play().catch(e => console.log("Waiting for interaction to play BGM"));
    }

    toggleMute() {
        this.muted = !this.muted;
        if (this.masterGain) {
            this.masterGain.gain.value = this.muted ? 0 : 0.3;
        }

        if (this.muted) {
            this.bgm.pause();
        } else {
            this.bgm.play().catch(e => { });
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
