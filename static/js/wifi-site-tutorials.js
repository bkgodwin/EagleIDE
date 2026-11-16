/* In-app Infra Sim tutorials. Diagrams and steps use only built-in content. */
(function () {
  'use strict';

  const diagram = content => `<svg viewBox="0 0 480 144" aria-hidden="true" focusable="false">${content}</svg>`;
  const box = (x, y, width, label, detail) => `<g class="wifi-guide-box">
    <rect x="${x}" y="${y}" width="${width}" height="52" rx="8"/>
    <text x="${x + width / 2}" y="${y + 22}">${label}</text>
    <text class="wifi-guide-small" x="${x + width / 2}" y="${y + 41}">${detail}</text>
  </g>`;

  const guides = [
    {
      title: 'Getting started',
      intro: 'Build a small wired and wireless network, then verify that a desktop can reach its router.',
      illustration: diagram(`<path class="wifi-guide-line" d="M140 72H172M306 72H324V37H340M324 72v35h16"/>
        ${box(12, 46, 128, 'Router', 'DHCP')}
        ${box(172, 46, 134, 'PoE switch', 'VLAN 0')}
        ${box(340, 11, 128, 'Desktop', 'Ethernet')}
        ${box(340, 81, 128, 'Access point', 'Ethernet + PoE')}`),
      caption: 'The switch connects the desktop and supplies power and data to the access point.',
      steps: [
        '<strong>Place the devices.</strong> Use <strong>Equipment</strong> to place a rack, a desktop, and a ceiling AP. Click the rack and use <strong>Install Equipment</strong> to mount a Router, 24-port Switch, and Patch Panel in open slots.',
        '<strong>Configure the rack.</strong> Click a chassis to open its settings beside the rack. Use <strong>+</strong> or <strong>−</strong> to resize the drawing, and <strong>Fit width</strong> to see both rails. Drag a chassis or use <strong>Mounting position</strong> to move it with its cables attached.',
        '<strong>Route building Ethernet.</strong> Choose <strong>Cable</strong> on the plan. Connect the desktop and AP to rear patch-panel ports by clicking each device, then the rack. Confirm the chosen port and press <strong>Connect</strong>.',
        '<strong>Patch inside the rack.</strong> Open the rack and select its <strong>Cable</strong> tool. Patch router ETH1 to switch ETH1. Hover a front patch-panel port to see the label of the device connected to its rear. Patch the two front ports to switch ETH2 and ETH3 to complete the desktop and AP circuits.',
        '<strong>Check the desktop.</strong> Use <strong>Select</strong> and click the desktop. Its inspector should show a DHCP address. Set <strong>Ping target</strong> to the router and press <strong>Start Ping</strong>.',
        '<strong>Try Wi-Fi.</strong> Place a Mobile Phone near the access point. Select it and check the associated AP, signal, and IPv4 address in its inspector.',
        '<strong>Keep a project file.</strong> Choose <strong>Download Project</strong> to keep an editable snapshot. Use <strong>Open Project File</strong> in Network Lab to open it as a new draft.',
        '<strong>Add Internet service if needed.</strong> Place an ISP Demarcation on a wall. Start the cable at the handoff and click the rack. Confirm the selected router WAN port, connect, and try the simulated Internet ping.',
      ],
    },
    {
      title: 'Rack equipment',
      intro: 'Mount equipment in a 16U rack, configure it beside the rack, and connect front patch cords to building runs.',
      illustration: diagram(`<path class="wifi-guide-line" d="M140 72h28m144 0h27"/>
        ${box(12, 46, 128, 'PoE switch', 'ETH2')}
        ${box(168, 46, 144, 'Patch panel', 'FRONT1 → BACK1')}
        ${box(339, 46, 129, 'Access point', 'Building run')}`),
      caption: 'A front patch cord and its matching rear run carry traffic and PoE from the switch to the access point.',
      steps: [
        '<strong>Place and open a rack.</strong> Choose <strong>Equipment</strong> on the floor plan, select <strong>Equipment Rack</strong>, and place it. Switch to <strong>Select</strong> and click the rack.',
        '<strong>Install equipment.</strong> Choose <strong>Install Equipment</strong>, select a device and an open mounting position, then click <strong>Install</strong>. Rack units count up from the bottom. A server or UPS occupies two units.',
        '<strong>Edit settings alongside the rack.</strong> In <strong>Select</strong>, click a chassis to edit its label and available settings. Router DHCP, VLANs, and firewall settings and managed switch port settings open in the same window. Use <strong>Rack Settings</strong> to name or position the rack.',
        '<strong>Connect the rear run.</strong> On the floor plan, give the remote device a label and use <strong>Cable</strong> to connect it to a rear port on the patch panel. In the rack view, hover over the matching front port to see the label.',
        '<strong>Patch the front.</strong> In the rack, choose <strong>Cable</strong> and pick Ethernet or SFP fiber. Zoom in with <strong>+</strong> and scroll as needed. Select two highlighted ports on different devices. The <strong>Patch cables</strong> list shows each connection and lets you disconnect it.',
        '<strong>Rearrange the rack.</strong> Return to <strong>Select</strong>, then drag a chassis to an open position or use its <strong>Mounting position</strong> menu. The cables stay connected and redraw at the new port positions. Choose <strong>Fit width</strong> to see the full width again.',
        '<strong>Host services on a rack server.</strong> Select the server and enable a service under <strong>Service VMs</strong>. Choose its VLAN, leave IPv4 blank for DHCP or enter an address in a reachable router’s subnet, and choose <strong>Save VM</strong>. Add the VM’s VLAN to the switch port facing the server. Select a client to see its <strong>Reachable server services</strong> and ping their addresses.',
        '<strong>Try it in Northfield.</strong> The Campus services server in Main IT Rack hosts staff DNS, a guest Web VM, and lab File sharing. Compare the Reachable server services on the STEM desktop and Visitor phone, then inspect the core switch port facing the server.',
      ],
    },
    {
      title: 'Wiring and cable routes',
      intro: 'Choose compatible ports and place bends so a cable follows your intended path.',
      illustration: diagram(`<path class="wifi-guide-line" d="M132 42H220v60h129"/>
        <circle class="wifi-guide-pin" cx="220" cy="42" r="6"/><circle class="wifi-guide-pin" cx="220" cy="102" r="6"/>
        <text class="wifi-guide-small" x="271" y="76">Bends</text>
        ${box(12, 16, 120, 'From', 'Free port')}
        ${box(349, 76, 120, 'To', 'Free port')}`),
      caption: 'Bends set the cable length. A building Ethernet run can be at most 90 m.',
      steps: [
        '<strong>Choose Cable and select the media.</strong> Use Ethernet for devices that need PoE. Use fiber between compatible SFP ports.',
        '<strong>Choose the source.</strong> Click it on the plan or use <strong>From</strong>. Check the selected port before adding bends.',
        '<strong>Follow the intended route.</strong> Click the plan to add bends. Hold Shift or enable <strong>Right angles</strong> to align bends. Click a pass-through marker where the cable crosses concrete.',
        '<strong>Finish the building run.</strong> Click the rack to pick a rear patch-panel port. The first free port on the highest panel is preselected. Connect, then open the rack and use its <strong>Cable</strong> tool to patch the corresponding front port.',
        '<strong>Check length.</strong> Add an IDF or use fiber between compatible SFP ports when a building Ethernet run reaches 90 m.',
        '<strong>Adjust a saved cable.</strong> Use <strong>Select</strong> and click the cable. If it belongs to a bundle, choose the cable from the list. Drag a bend or use <strong>Edit Route &amp; Ports</strong>, then <strong>Save Route</strong>.',
      ],
    },
    {
      title: 'Concrete pass-throughs',
      intro: 'Give a cable a specific crossing point through a concrete or reinforced concrete wall.',
      illustration: diagram(`<path class="wifi-guide-wall" d="M240 15v42m0 30v42"/>
        <path class="wifi-guide-line" d="M132 72H348"/>
        <rect class="wifi-guide-pin" x="229" y="61" width="22" height="22" rx="4"/>
        <text class="wifi-guide-small" x="240" y="119">Concrete wall</text>
        ${box(12, 46, 120, 'Switch', 'Ethernet')}
        ${box(348, 46, 120, 'AP', 'Ethernet')}`),
      caption: 'The square marker is the waypoint where the cable crosses concrete.',
      steps: [
        '<strong>Place a crossing.</strong> Choose <strong>Pass-through</strong> and click a concrete or reinforced concrete wall.',
        '<strong>Route through the marker.</strong> Start a cable and click the pass-through on your way to the destination. Then connect the two ports.',
        '<strong>Check the crossing.</strong> Select the pass-through to see which cables use it. Infra Sim allows up to 10 cables per pass-through and requires 20 ft (6.1 m) between them on the same wall.',
        '<strong>Fix a blocked route.</strong> If a cable still crosses concrete without a pass-through, check for another wall crossing. Reroute the cable or add a pass-through where needed.',
      ],
    },
    {
      title: 'VLANs and switch ports',
      intro: 'Assign clients to VLANs and carry those VLANs between network devices.',
      illustration: diagram(`<path class="wifi-guide-line" d="M145 37h28v70h-28m28-35h11m137 0h26"/>
        ${box(11, 11, 134, 'Staff', 'Access VLAN 10')}
        ${box(11, 81, 134, 'Guest', 'Access VLAN 20')}
        ${box(184, 46, 137, 'PoE switch', 'VLANs 10 and 20')}
        ${box(347, 46, 122, 'Router', 'DHCP + rules')}`),
      caption: 'Each client port has an access VLAN. The uplink carries both VLANs toward the router.',
      steps: [
        '<strong>Create a VLAN.</strong> Select the router, expand <strong>VLANs</strong>, and choose <strong>New VLAN…</strong>. Enter a name and unused ID, then press <strong>Add VLAN</strong>. VLAN 0 is the default untagged LAN.',
        '<strong>Assign a client port.</strong> Select a managed switch and open <strong>Switch ports</strong>. Choose the port connected to the client and set its <strong>Access VLAN</strong>.',
        '<strong>Carry the VLAN to the router.</strong> On switch uplinks and AP links, use <strong>Additional tagged VLANs</strong> for any VLANs the port needs beyond its access VLAN. Match the allowed VLANs at both ends of switch-to-switch links.',
        '<strong>Verify the result.</strong> Select the client and check its VLAN and IPv4 address. If it has no address, trace its port assignments back to the router and check the router’s DHCP pool.',
        '<strong>Set access rules when needed.</strong> Use the router’s <strong>Firewall</strong> to control traffic between VLANs. Rules are checked in order. Traffic within the same VLAN stays on the switch.',
      ],
    },
    {
      title: 'SSIDs and Wi-Fi',
      intro: 'Create a shared Wi-Fi network and choose which access points broadcast it.',
      illustration: diagram(`<path class="wifi-guide-line" d="M139 72h26m127 0h18V37h20m-20 35v35h20"/>
        ${box(12, 46, 127, 'PoE switch', 'VLANs 0 and 20')}
        ${box(165, 46, 127, 'Access point', '2 SSIDs')}
        ${box(330, 11, 138, 'Staff Wi-Fi', 'VLAN 0')}
        ${box(330, 81, 138, 'Guest Wi-Fi', 'VLAN 20')}`),
      caption: 'A powered access point can broadcast multiple SSIDs, each mapped to a VLAN.',
      steps: [
        '<strong>Start with a powered AP.</strong> Connect the access point by Ethernet to a PoE switch. Create the intended VLAN on the router first if you need one.',
        '<strong>Add or edit the network.</strong> Select the AP. Under <strong>Shared SSID</strong>, choose <strong>Add SSID…</strong> or an existing name. Set <strong>SSID name</strong>, <strong>Radio band</strong>, and <strong>VLAN ID</strong>, then choose <strong>Add SSID</strong> or <strong>Save SSID</strong>.',
        '<strong>Choose which APs broadcast it.</strong> Select the shared SSID on each AP and set <strong>Broadcast on this AP</strong>. The AP switch port and the uplinks must carry the SSID’s VLAN.',
        '<strong>Verify association and coverage.</strong> Select a mobile phone and set its <strong>Wi-Fi SSID</strong>. Check its AP and IPv4 address. Open <strong>Wi-Fi</strong> and filter by SSID and band to review its coverage.',
      ],
    },
    {
      title: 'Running a ping',
      intro: 'Send simulated packets and use the return path and drop counts to diagnose the connection.',
      illustration: diagram(`<path class="wifi-guide-line" d="M138 60h204m-8-7 8 7-8 7"/>
        <path class="wifi-guide-return" d="M342 81H138m8-7-8 7 8 7"/>
        <text class="wifi-guide-small" x="240" y="42">Request</text>
        <text class="wifi-guide-small" x="240" y="108">Reply</text>
        ${box(12, 44, 126, 'Source', 'Client')}
        ${box(342, 44, 126, 'Target', 'Router or client')}`),
      caption: 'A successful ping sends a request and receives a reply. RTT is the simulated round-trip time.',
      steps: [
        '<strong>Choose a source.</strong> Select a desktop, phone, or other client. Check that it shows an IPv4 address and a connected uplink.',
        '<strong>Choose a target.</strong> In <strong>Ping target</strong>, pick the router for a local baseline or another client to test a specific path. Use the Internet target when an ISP demarcation is connected.',
        '<strong>Start the test.</strong> Press <strong>Start Ping</strong>. Watch the packets on the plan. Use <strong>Stop Ping</strong> when you have enough samples.',
        '<strong>Read the result.</strong> Check arrived, dropped, and sent counts and the average RTT. If packets drop, read <strong>Last drop</strong> and check the relevant link, VLAN, firewall rule, or Wi-Fi signal.',
      ],
    },
    {
      title: 'Signal strength and packet loss',
      intro: 'Compare radio coverage at specific spots, then test whether a wireless client can exchange packets there.',
      illustration: diagram(`<path class="wifi-guide-wall" d="M220 16v112"/>
        <path class="wifi-guide-return" d="M84 67h306"/>
        <circle class="wifi-guide-pin" cx="84" cy="67" r="12"/>
        <circle class="wifi-guide-pin" cx="164" cy="67" r="7"/>
        <circle class="wifi-guide-pin" cx="390" cy="67" r="7"/>
        <text x="84" y="108">AP</text><text class="wifi-guide-small" x="164" y="42">−55 dBm</text>
        <text class="wifi-guide-small" x="390" y="42">−78 dBm</text>
        <text class="wifi-guide-small" x="263" y="119">Barrier</text>`),
      caption: 'In this illustration, −55 dBm is stronger than −78 dBm. Check the actual estimate on your plan.',
      steps: [
        '<strong>Choose a network and band.</strong> In <strong>Wi-Fi</strong>, select the SSID and band you want to inspect. Enable <strong>Wi-Fi coverage</strong> to see the heatmap.',
        '<strong>Probe a location.</strong> Open <strong>View</strong>, choose <strong>Check Signal</strong>, then click a spot. Read the estimated dBm, strongest AP, and barriers crossed. Compare both sides of a wall or door. The probe separates received signal from the interference penalty. Change a nearby AP’s channel or width to compare.',
        '<strong>Test packet loss.</strong> Place or move a Mobile Phone to that spot and select the same SSID. Ping the router and compare the dropped percentage over several packets with a test near the AP.',
        '<strong>Check what changed.</strong> Confirm which AP and band the phone actually uses. If the signal is strong and pings still drop, check the client’s network path and <strong>Last drop</strong>.',
      ],
    },
    {
      title: 'Placing and aiming cameras',
      intro: 'Power a ceiling camera and use its field of view to check coverage of an entrance or walkway.',
      illustration: diagram(`<path class="wifi-guide-cone" d="M125 72 354 16Q379 72 354 128Z"/>
        <path class="wifi-guide-return" d="M125 72h252"/>
        <path class="wifi-guide-wall" d="M357 16v32m0 48v32"/>
        <rect class="wifi-guide-pin" x="113" y="60" width="24" height="24" rx="5"/>
        <circle class="wifi-guide-pin" cx="282" cy="72" r="8"/>
        <text class="wifi-guide-small" x="125" y="111">Camera</text>
        <text class="wifi-guide-small" x="282" y="47">Aim handle</text>
        <text class="wifi-guide-small" x="421" y="78">Doorway</text>`),
      caption: 'Drag the aim handle inside the cone to point the camera toward the area you want to cover.',
      steps: [
        '<strong>Place and power the camera.</strong> Choose <strong>Equipment</strong>, select <strong>PoE Camera</strong>, and click a position. Connect Ethernet from a PoE switch. Each camera draws 12 W.',
        '<strong>Reveal its view.</strong> Enable <strong>Camera coverage</strong> in <strong>View</strong>. Use <strong>Select</strong> and click the camera.',
        '<strong>Aim the camera.</strong> Drag the handle in the cone. Hold Shift while dragging to snap to 15° increments. You can also enter <strong>Direction (°)</strong> in the inspector.',
        '<strong>Adjust the footprint.</strong> Set <strong>Field of view (°)</strong> and <strong>View range</strong>. Check the cone around walls and openings. Hide the overlay from <strong>View</strong> when you are finished.',
      ],
    },
  ];

  function create(menu, dialog) {
    const trigger = menu.querySelector('summary');
    const list = menu.querySelector('.wifi-toolbar-dropdown');
    const title = dialog.querySelector('h2');
    const page = dialog.querySelector('.wifi-tutorial-page');
    const previous = dialog.querySelector('#wifiTutorialPrevious');
    const next = dialog.querySelector('#wifiTutorialNext');
    let current = 0;

    function render(index) {
      current = index;
      const guide = guides[index];
      title.textContent = guide.title;
      page.innerHTML = `<p class="wifi-tutorial-intro">${guide.intro}</p>
        <figure>${guide.illustration}<figcaption>${guide.caption}</figcaption></figure>
        <ol>${guide.steps.map(step => `<li>${step}</li>`).join('')}</ol>`;
      previous.disabled = !guides[index - 1];
      next.disabled = !guides[index + 1];
      previous.setAttribute('aria-label', previous.disabled ? 'Previous tutorial' : `Previous tutorial: ${guides[index - 1].title}`);
      next.setAttribute('aria-label', next.disabled ? 'Next tutorial' : `Next tutorial: ${guides[index + 1].title}`);
      page.scrollTop = 0;
    }

    function focusTitle() {
      title.focus({ preventScroll: true });
    }

    const buttons = guides.map((guide, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wifi-control';
      button.textContent = guide.title;
      button.setAttribute('aria-haspopup', 'dialog');
      button.addEventListener('click', () => {
        menu.open = false;
        trigger.focus({ preventScroll: true });
        render(index);
        dialog.showModal();
        focusTitle();
      });
      return button;
    });
    list.replaceChildren(...buttons);
    previous.addEventListener('click', () => { render(current - 1); focusTitle(); });
    next.addEventListener('click', () => { render(current + 1); focusTitle(); });
    dialog.addEventListener('close', () => {
      if (!dialog.open && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
    });
  }

  window.WifiSiteTutorials = { create };
})();
