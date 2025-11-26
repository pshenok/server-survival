# Server Survival 🖥️🔥

![Gameplay Demo](assets/gameplay.gif)

**Server Survival** is an interactive 3D simulation game where you play as a **Cloud Architect**. Your mission is to build and scale a resilient cloud infrastructure to handle increasing traffic loads while fighting off DDoS attacks and managing your budget.

## 🎮 How to Play

### Objective
Survive as long as possible! Manage your **Budget ($)** and **Reputation (%)**.
- **Earn Money** by successfully processing legitimate traffic (Web & API).
- **Lose Reputation** if requests fail or if Fraud traffic slips through.
- **Game Over** if Reputation hits 0% or you go bankrupt.

### Traffic Types
- 🟢 **Web Traffic (Green):** Needs to be stored in **S3**.
- 🟠 **API Traffic (Orange):** Needs to be processed and saved to a **Database**.
- 🟣 **Fraud/DDoS (Pink):** Must be blocked by a **WAF**.

### Infrastructure & Services
Build your architecture using the toolbar. Each service has a cost and upkeep:

| Service | Cost | Upkeep | Function |
| :--- | :--- | :--- | :--- |
| **WAF** | $50 | Low | **Firewall.** The first line of defense. Blocks Fraud traffic. |
| **ALB** | $50 | Medium | **Load Balancer.** Distributes traffic to multiple Compute instances. |
| **Compute** | $100 | High | **EC2 Instance.** Processes requests. **Upgradeable (Tiers 1-3).** |
| **Database** | $200 | Very High | **RDS.** Destination for API traffic. **Upgradeable (Tiers 1-3).** |
| **S3** | $25 | Low | **Storage.** Destination for Web traffic. |

### Scoring & Economy
- **Web Request:** +$1.25 / +5 Score
- **API Request:** +$1.25 / +5 Score
- **Fraud Blocked:** +5 Score
- **Fraud Leak:** -5 Reputation

### Game Modes

#### Survival Mode
The classic experience - survive as long as possible against escalating traffic.

#### Sandbox Mode
A fully customizable testing environment for experimenting with any architecture:

| Control | Description |
| :--- | :--- |
| **Budget** | Set any starting budget (slider 0-10K, or type any amount) |
| **RPS** | Control traffic rate (0 = stopped, or type 100+ for stress tests) |
| **Traffic Mix** | Adjust WEB/API/FRAUD percentages independently |
| **Burst** | Spawn instant bursts of specific traffic types |
| **Upkeep Toggle** | Enable/disable service costs |
| **Clear All** | Reset all services and restore budget |

**No game over in Sandbox** - experiment freely!

### Last Features
- **Sandbox Mode:** Full control over budget, traffic rate, traffic mix, and burst spawning
- **ESC Menu:** Press ESC to pause and open main menu, Resume to return (stays paused)
- **Service Upgrades:** Click on **Compute** or **Database** instances with their respective tools to upgrade them.
    - **Tier 2:** Increased capacity (Cost: $200/$400).
    - **Tier 3:** Maximum capacity (Cost: $250/$600).
- **Smart Load Balancing:** ALBs now use **Round Robin** to distribute traffic evenly across all connected instances.
- **Visual Feedback:** Upgradeable services glow when hovered, and rings indicate their current tier.

### Controls
- **Left Click:** Select tools, place services, and connect nodes.
- **Right Click + Drag:** Pan the camera.
- **ESC:** Open main menu and pause game. Press again or click Resume to close menu (stays paused).
- **Camera Reset:** Press `R` to reset the camera position.
- **Birds-Eye View:** Press `T` to switch between isometric and top-down view.
- **Hide HUD:** Press `H` to toggle UI panels.
- **Connect Tool:** Click two nodes to create a connection (flow direction matters!).
    - *Valid Flows:* Internet -> WAF -> ALB -> Compute -> (DB/S3)
- **Delete Tool:** Remove services to recover 50% of the cost.
- **Time Controls:** Pause, Play (1x), and Fast Forward (3x).

## 🧠 Strategy Tips
1.  **Block Fraud First:** Always place a WAF immediately connected to the Internet. Fraud leaks destroy reputation fast.
2.  **Scale Compute:** As traffic increases, a single Compute node won't be enough. Use an ALB to split traffic across multiple Compute nodes.
3.  **Watch Your Queues:** If a service's queue fills up (red ring), requests will fail. Add more capacity!
4.  **Budget Wisely:** Databases are expensive. Don't over-provision them early on.

## 🛠️ Tech Stack

- **Core:** Vanilla JavaScript (ES6+)
- **Rendering:** [Three.js](https://threejs.org/) for 3D visualization.
- **Styling:** [Tailwind CSS](https://tailwindcss.com/) for the glassmorphism UI.
- **Build:** No build step required! Just standard HTML/CSS/JS.

## 🚀 Getting Started

1.  Clone the repository.
2.  Open `index.html` in your modern web browser.
3.  Start building your cloud empire!


## 💬 Community

Join our Discord server to discuss strategies and share your high scores:
[Join Discord](https://discord.gg/bYSktNXy)

---
*Built with code and chaos.*