const TUTORIAL_STORAGE_KEY = 'serverSurvivalTutorialComplete';

const TUTORIAL_STEPS = [
    {
        id: 'welcome',
        title: 'Welcome, Architect!',
        text: 'You are in charge of a server infrastructure. Your goal is to route incoming traffic correctly and protect against attacks. Let\'s build your first setup!',
        icon: '👋',
        highlight: null,
        action: 'next',
        hint: 'Traffic will start flowing once you press Play. First, let\'s prepare your defenses!'
    },
    {
        id: 'place-firewall',
        title: 'Deploy Firewall',
        text: 'The <span class="text-purple-400 font-bold">Firewall</span> is your first line of defense. It blocks malicious FRAUD traffic that can destroy your reputation. Click the FW button, then click on the grid to place it.',
        icon: '🛡️',
        highlight: 'tool-waf',
        action: 'place_waf',
        hint: 'Place the Firewall close to the Internet node (the cyan box on the left) for easier connection.'
    },
    {
        id: 'connect-firewall',
        title: 'Connect to Internet',
        text: 'Great! Now connect the <span class="text-cyan-400 font-bold">Internet</span> to your Firewall. Select the <span class="text-blue-400 font-bold">Link</span> tool, click on Internet first, then click on the Firewall.',
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_internet_waf',
        hint: 'All traffic enters through the Internet node. Without this connection, no traffic will reach your infrastructure.'
    },
    {
        id: 'place-lb',
        title: 'Deploy Load Balancer',
        text: 'The <span class="text-blue-400 font-bold">Load Balancer</span> distributes traffic across multiple servers. This prevents overload and improves reliability.',
        icon: '⚖️',
        highlight: 'tool-alb',
        action: 'place_alb',
        hint: 'Load Balancers use Round Robin to evenly distribute requests.'
    },
    {
        id: 'connect-fw-lb',
        title: 'Connect Firewall to LB',
        text: 'Connect your Firewall to the Load Balancer. Clean traffic will flow from Firewall → Load Balancer.',
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_waf_alb',
        hint: 'Traffic flow: Internet → Firewall (blocks FRAUD) → Load Balancer → ...'
    },
    {
        id: 'place-compute',
        title: 'Deploy Compute Server',
        text: '<span class="text-orange-400 font-bold">Compute</span> processes all requests. It\'s the brain of your infrastructure that routes WEB and API traffic to the correct storage.',
        icon: '⚡',
        highlight: 'tool-lambda',
        action: 'place_compute',
        hint: 'You can upgrade Compute later to handle more traffic (Tier 1 → 2 → 3).'
    },
    {
        id: 'connect-lb-compute',
        title: 'Connect LB to Compute',
        text: 'Connect the Load Balancer to your Compute server.',
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_alb_compute',
        hint: 'You can add multiple Compute servers and the Load Balancer will distribute traffic between them.'
    },
    {
        id: 'place-storage',
        title: 'Deploy File Storage',
        text: '<span class="text-emerald-400 font-bold">File Storage</span> handles WEB traffic (green requests). Without it, WEB requests will fail!',
        icon: '📁',
        highlight: 'tool-s3',
        action: 'place_s3',
        hint: 'WEB traffic = static files, images, HTML pages.'
    },
    {
        id: 'place-db',
        title: 'Deploy SQL Database',
        text: '<span class="text-red-400 font-bold">SQL Database</span> handles API traffic (orange requests). APIs need database storage to function.',
        icon: '🗄️',
        highlight: 'tool-db',
        action: 'place_db',
        hint: 'API traffic = dynamic data, user requests, business logic.'
    },
    {
        id: 'connect-compute-storage',
        title: 'Connect to Storage',
        text: 'Connect <span class="text-orange-400">Compute</span> to <span class="text-emerald-400">File Storage</span>. Use the Link tool.',
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_compute_s3',
        hint: 'Compute automatically routes WEB traffic to File Storage.'
    },
    {
        id: 'connect-compute-db',
        title: 'Connect to Database',
        text: 'Connect <span class="text-orange-400">Compute</span> to <span class="text-red-400">SQL Database</span>.',
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_compute_db',
        hint: 'Compute automatically routes API traffic to SQL Database.'
    },
    {
        id: 'ready',
        title: 'Infrastructure Ready!',
        text: 'Your basic infrastructure is complete! Press the <span class="text-green-400 font-bold">Play</span> button to start the simulation. Watch as traffic flows through your system!',
        icon: '🚀',
        highlight: 'btn-play',
        action: 'start_game',
        hint: 'Monitor the colored rings around services - green is good, red means overload. Upgrade or add more services as needed!'
    },
    {
        id: 'complete',
        title: 'Tutorial Complete!',
        text: '<span class="text-green-400">Congratulations!</span> You now know the basics. Remember:<br><br>• <span class="text-purple-400">Purple</span> FRAUD → Block with Firewall<br>• <span class="text-green-400">Green</span> WEB → Route to File Storage<br>• <span class="text-orange-400">Orange</span> API → Route to SQL Database<br><br>Good luck, Architect!',
        icon: '🎉',
        highlight: null,
        action: 'finish',
        hint: 'Don\'t worry if your budget goes negative at first! Just like real infrastructure - you invest upfront, then profit comes from processed traffic. Each completed request earns money!'
    }
];

class Tutorial {
    constructor() {
        this.currentStep = 0;
        this.isActive = false;
        this.completedActions = new Set();
        this.modal = document.getElementById('tutorial-modal');
        this.popup = document.getElementById('tutorial-popup');
        this.backdrop = document.getElementById('tutorial-backdrop');
        this.highlight = document.getElementById('tutorial-highlight');
        this.titleEl = document.getElementById('tutorial-title');
        this.textEl = document.getElementById('tutorial-text');
        this.iconEl = document.getElementById('tutorial-icon');
        this.stepNumEl = document.getElementById('tutorial-step-num');
        this.totalStepsEl = document.getElementById('tutorial-total-steps');
        this.hintEl = document.getElementById('tutorial-hint');
        this.hintTextEl = document.getElementById('tutorial-hint-text');
        this.nextBtn = document.getElementById('tutorial-next');
        this.skipBtn = document.getElementById('tutorial-skip');
        this.progressEl = document.getElementById('tutorial-progress');
        this.setupEventListeners();
    }

    setupEventListeners() {
        this.nextBtn?.addEventListener('click', () => this.nextStep());
        this.skipBtn?.addEventListener('click', () => this.skip());
    }

    isCompleted() {
        return localStorage.getItem(TUTORIAL_STORAGE_KEY) === 'true';
    }

    markCompleted() {
        localStorage.setItem(TUTORIAL_STORAGE_KEY, 'true');
    }

    reset() {
        localStorage.removeItem(TUTORIAL_STORAGE_KEY);
    }

    start() {
        if (this.isCompleted()) {
            return false;
        }

        this.isActive = true;
        this.currentStep = 0;
        this.completedActions.clear();
        this.modal.classList.remove('hidden');
        this.totalStepsEl.textContent = TUTORIAL_STEPS.length;
        this.renderProgress();
        this.popup.classList.add('tutorial-enter');
        setTimeout(() => this.popup.classList.remove('tutorial-enter'), 500);
        this.showStep();
        document.getElementById('btn-play')?.classList.remove('pulse-green');

        return true;
    }

    showStep() {
        const step = TUTORIAL_STEPS[this.currentStep];
        if (!step) return;

        this.titleEl.textContent = step.title;
        this.textEl.innerHTML = step.text;
        this.iconEl.textContent = step.icon;
        this.stepNumEl.textContent = this.currentStep + 1;

        if (step.hint) {
            this.hintEl.classList.remove('hidden');
            this.hintTextEl.textContent = step.hint;
        } else {
            this.hintEl.classList.add('hidden');
        }

        if (step.action === 'next' || step.action === 'finish') {
            this.nextBtn.classList.remove('hidden');
            this.nextBtn.textContent = step.action === 'finish' ? 'Start Playing!' : 'Next';
        } else {
            this.nextBtn.classList.add('hidden');
        }

        this.clearHighlights();
        if (step.highlight) this.highlightElement(step.highlight);
        this.positionPopup(step);
        this.updateProgress();
    }

    highlightElement(elementId) {
        const el = document.getElementById(elementId);
        if (!el) return;
        el.classList.add('tutorial-tool-highlight');
        const rect = el.getBoundingClientRect();
        this.highlight.style.left = `${rect.left - 4}px`;
        this.highlight.style.top = `${rect.top - 4}px`;
        this.highlight.style.width = `${rect.width + 8}px`;
        this.highlight.style.height = `${rect.height + 8}px`;
        this.highlight.classList.remove('hidden');
    }

    clearHighlights() {
        document.querySelectorAll('.tutorial-tool-highlight').forEach(el => el.classList.remove('tutorial-tool-highlight'));
        this.highlight.classList.add('hidden');
    }

    positionPopup(step) {
        if (step.id === 'welcome') {
            this.popup.style.right = 'auto';
            this.popup.style.bottom = 'auto';
            this.popup.style.left = '50%';
            this.popup.style.top = '50%';
            this.popup.style.transform = 'translate(-50%, -50%)';
        } else {
            this.popup.style.transform = '';
            this.popup.style.left = 'auto';
            this.popup.style.top = 'auto';
            this.popup.style.right = '20px';
            this.popup.style.bottom = '140px';
        }
    }

    renderProgress() {
        this.progressEl.innerHTML = '';
        TUTORIAL_STEPS.forEach((_, i) => {
            const dot = document.createElement('div');
            dot.className = 'w-2 h-2 rounded-full transition-all duration-300';
            if (i < this.currentStep) {
                dot.className += ' bg-cyan-500';
            } else if (i === this.currentStep) {
                dot.className += ' bg-cyan-400 w-4';
            } else {
                dot.className += ' bg-gray-600';
            }
            this.progressEl.appendChild(dot);
        });
    }

    updateProgress() {
        const dots = this.progressEl.children;
        for (let i = 0; i < dots.length; i++) {
            const dot = dots[i];
            dot.className = 'w-2 h-2 rounded-full transition-all duration-300';
            if (i < this.currentStep) {
                dot.className += ' bg-cyan-500';
            } else if (i === this.currentStep) {
                dot.className += ' bg-cyan-400 w-4';
            } else {
                dot.className += ' bg-gray-600';
            }
        }
    }

    nextStep() {
        const step = TUTORIAL_STEPS[this.currentStep];

        if (step.action === 'finish') {
            this.complete();
            return;
        }

        this.currentStep++;
        if (this.currentStep >= TUTORIAL_STEPS.length) {
            this.complete();
        } else {
            this.popup.classList.add('tutorial-step-change');
            setTimeout(() => this.popup.classList.remove('tutorial-step-change'), 300);
            this.showStep();
            new Audio('assets/sounds/click-5.mp3').play();
        }
    }

    onAction(actionType, data = {}) {
        if (!this.isActive) return;

        const step = TUTORIAL_STEPS[this.currentStep];
        if (!step) return;

        let actionMatches = false;

        switch (step.action) {
            case 'place_waf':
                actionMatches = actionType === 'place' && data.type === 'waf';
                break;
            case 'place_alb':
                actionMatches = actionType === 'place' && data.type === 'alb';
                break;
            case 'place_compute':
                actionMatches = actionType === 'place' && data.type === 'compute';
                break;
            case 'place_s3':
                actionMatches = actionType === 'place' && data.type === 's3';
                break;
            case 'place_db':
                actionMatches = actionType === 'place' && data.type === 'db';
                break;
            case 'connect_internet_waf':
                actionMatches = actionType === 'connect' && data.from === 'internet' && data.toType === 'waf';
                break;
            case 'connect_waf_alb':
                actionMatches = actionType === 'connect' && data.fromType === 'waf' && data.toType === 'alb';
                break;
            case 'connect_alb_compute':
                actionMatches = actionType === 'connect' && data.fromType === 'alb' && data.toType === 'compute';
                break;
            case 'connect_compute_s3':
                actionMatches = actionType === 'connect' && data.fromType === 'compute' && data.toType === 's3';
                break;
            case 'connect_compute_db':
                actionMatches = actionType === 'connect' && data.fromType === 'compute' && data.toType === 'db';
                break;
            case 'start_game':
                actionMatches = actionType === 'start_game';
                break;
        }

        if (actionMatches) {
            this.completedActions.add(step.action);
            setTimeout(() => {
                this.nextStep();
            }, 300);
        }
    }

    skip() {
        if (confirm('Skip tutorial? You can always read the Manual (?) for help.')) {
            this.complete();
        }
    }

    complete() {
        this.isActive = false;
        this.clearHighlights();
        this.modal.classList.add('hidden');
        this.markCompleted();
        STATE?.sound?.playSuccess();
    }

    hide() {
        this.modal.classList.add('hidden');
        this.clearHighlights();
    }

    show() {
        if (this.isActive) {
            this.modal.classList.remove('hidden');
            this.showStep();
        }
    }
}

window.tutorial = new Tutorial();
window.resetTutorial = () => {
    window.tutorial.reset();
    console.log('Tutorial reset. Start a new Survival game to see the tutorial.');
};
