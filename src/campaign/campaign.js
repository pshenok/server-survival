// Campaign mode controller. Single instance assigned to window.campaign.
class CampaignController {
    constructor() {
        this.active = false;
    }
    tick() {} // called from animate loop, no-op until Task 5
}
window.campaign = new CampaignController();
