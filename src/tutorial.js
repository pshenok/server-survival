const TUTORIAL_STORAGE_KEY = 'serverSurvivalTutorialComplete';

const TUTORIAL_STEPS = [
    {
        id: 'welcome',
        title: i18n.t('tut_welcome_title'),
        text: i18n.t('tut_welcome_text'),
        icon: '👋',
        highlight: null,
        action: 'next',
        position: 'center',
        hint: i18n.t('tut_welcome_hint')
    },
    {
        id: 'traffic-types',
        title: i18n.t('tut_traffic_types_title'),
        text: '<div class="space-y-2 text-left text-sm">' +
            `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-green-400 inline-block"></span><span class="text-green-400 font-bold w-16">${i18n.t('tut_traffic_types_static')}</span><span class="text-gray-300">${i18n.t('tut_traffic_types_static_desc')}<span class="text-emerald-400">${i18n.t('storage_short')}</span></span></div>` +
            `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-blue-400 inline-block"></span><span class="text-blue-400 font-bold w-16">${i18n.t('tut_traffic_types_read')}</span><span class="text-gray-300">${i18n.t('tut_traffic_types_read_desc')}<span class="text-red-400">${i18n.t('db_short')}</span></span></div>` +
            `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-orange-400 inline-block"></span><span class="text-orange-400 font-bold w-16">${i18n.t('tut_traffic_types_write')}</span><span class="text-gray-300">${i18n.t('tut_traffic_types_write_desc')}<span class="text-red-400">${i18n.t('db_short')}</span></span></div>` +
            `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-yellow-400 inline-block"></span><span class="text-yellow-400 font-bold w-16">${i18n.t('tut_traffic_types_upload')}</span><span class="text-gray-300">${i18n.t('tut_traffic_types_upload_desc')}<span class="text-emerald-400">${i18n.t('storage_short')}</span></span></div>` +
            `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-cyan-400 inline-block"></span><span class="text-cyan-400 font-bold w-16">${i18n.t('tut_traffic_types_search')}</span><span class="text-gray-300">${i18n.t('tut_traffic_types_search_desc')}<span class="text-red-400">${i18n.t('db_short')}</span></span></div>` +
            `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-red-400 inline-block"></span><span class="text-red-400 font-bold w-16">${i18n.t('tut_traffic_types_attack')}</span><span class="text-gray-300">${i18n.t('tut_traffic_types_attack_desc')}<span class="text-purple-400">${i18n.t('tut_traffic_types_block_fw')}</span></span></div>` +
            '</div>' +
            '<div class="mt-3 pt-2 border-t border-gray-700 text-xs text-gray-400">' +
            `<div class="flex justify-between"><span>${i18n.t('tut_traffic_types_cache_hint')}</span><span>${i18n.t('traffic_static')} 90% • ${i18n.t('traffic_read')} 40% • ${i18n.t('traffic_search')} 15%</span></div>` +
            `<div class="flex justify-between"><span>${i18n.t('tut_traffic_types_heavy_hint')}</span><span>${i18n.t('traffic_upload')} 2× • ${i18n.t('traffic_search')} 2.5×</span></div>` +
            '</div>',
        icon: '🌐',
        highlight: null,
        action: 'next',
        position: 'center',
        hint: i18n.t('tut_traffic_types_hint')
    },
    {
        id: 'place-firewall',
        title: i18n.t('tut_place_fw_title'),
        text: i18n.t('tut_place_fw_text'),
        icon: '🛡️',
        highlight: 'tool-waf',
        action: 'place_waf',
        hint: i18n.t('tut_place_fw_hint')
    },
    {
        id: 'connect-firewall',
        title: i18n.t('tut_connect_fw_title'),
        text: i18n.t('tut_connect_fw_text'),
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_internet_waf',
        hint: i18n.t('tut_connect_fw_hint')
    },
    {
        id: 'place-lb',
        title: i18n.t('tut_place_lb_title'),
        text: i18n.t('tut_place_lb_text'),
        icon: '⚖️',
        highlight: 'tool-alb',
        action: 'place_alb',
        hint: i18n.t('tut_place_lb_hint')
    },
    {
        id: 'connect-fw-lb',
        title: i18n.t('tut_connect_fw_lb_title'),
        text: i18n.t('tut_connect_fw_lb_text'),
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_waf_alb',
        hint: i18n.t('tut_connect_fw_lb_hint')
    },
    {
        id: 'place-compute',
        title: i18n.t('tut_place_compute_title'),
        text: i18n.t('tut_place_compute_text'),
        icon: '⚡',
        highlight: 'tool-lambda',
        action: 'place_compute',
        hint: i18n.t('tut_place_compute_hint')
    },
    {
        id: 'connect-lb-compute',
        title: i18n.t('tut_connect_lb_compute_title'),
        text: i18n.t('tut_connect_lb_compute_text'),
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_alb_compute',
        hint: i18n.t('tut_connect_lb_compute_hint')
    },
    {
        id: 'place-storage',
        title: i18n.t('tut_place_storage_title'),
        text: i18n.t('tut_place_storage_text'),
        icon: '📁',
        highlight: 'tool-s3',
        action: 'place_s3',
        hint: i18n.t('tut_place_storage_hint')
    },
    {
        id: 'place-cdn',
        title: i18n.t('tut_place_cdn_title'),
        text: i18n.t('tut_place_cdn_text'),
        icon: '🌍',
        highlight: 'tool-cdn',
        action: 'place_cdn',
        hint: i18n.t('tut_place_cdn_hint')
    },
    {
        id: 'connect-internet-cdn',
        title: i18n.t('tut_connect_internet_cdn_title'),
        text: i18n.t('tut_connect_internet_cdn_text'),
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_internet_cdn',
        hint: i18n.t('tut_connect_internet_cdn_hint')
    },
    {
        id: 'connect-cdn-s3',
        title: i18n.t('tut_connect_cdn_s3_title'),
        text: i18n.t('tut_connect_cdn_s3_text'),
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_cdn_s3',
        hint: i18n.t('tut_connect_cdn_s3_hint')
    },
    {
        id: 'place-db',
        title: i18n.t('tut_place_db_title'),
        text: i18n.t('tut_place_db_text'),
        icon: '🗄️',
        highlight: 'tool-db',
        action: 'place_db',
        hint: i18n.t('tut_place_db_hint')
    },
    {
        id: 'connect-compute-storage',
        title: i18n.t('tut_connect_compute_storage_title'),
        text: i18n.t('tut_connect_compute_storage_text'),
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_compute_s3',
        hint: i18n.t('tut_connect_compute_storage_hint')
    },
    {
        id: 'connect-compute-db',
        title: i18n.t('tut_connect_compute_db_title'),
        text: i18n.t('tut_connect_compute_db_text'),
        icon: '🔗',
        highlight: 'tool-connect',
        action: 'connect_compute_db',
        hint: i18n.t('tut_connect_compute_db_hint')
    },
    {
        id: 'ready',
        title: i18n.t('tut_ready_title'),
        text: i18n.t('tut_ready_text'),
        icon: '🚀',
        highlight: 'btn-play',
        action: 'start_game',
        hint: i18n.t('tut_ready_hint')
    },
    {
        id: 'complete',
        title: i18n.t('tut_complete_title'),
        text: i18n.t('tut_complete_text'),
        icon: '🎉',
        highlight: null,
        action: 'finish',
        position: 'center',
        hint: i18n.t('tut_complete_hint')
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
        this.stepContainerEl = document.getElementById('tutorial-step-container');
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
        this.isActive = true;
        this.currentStep = 0;
        this.completedActions.clear();
        this.modal.classList.remove('hidden');
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
        
        if (this.stepContainerEl) {
            this.stepContainerEl.textContent = i18n.t('step_x_of_y', {
                step: this.currentStep + 1,
                total: TUTORIAL_STEPS.length
            });
        }

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
        if (step.position === 'center') {
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
            case 'place_cdn':
                actionMatches = actionType === 'place' && data.type === 'cdn';
                break;
            case 'connect_internet_cdn':
                actionMatches = actionType === 'connect' && data.from === 'internet' && data.toType === 'cdn';
                break;
            case 'connect_cdn_s3':
                actionMatches = actionType === 'connect' && data.fromType === 'cdn' && data.toType === 's3';
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
        this.complete();
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
