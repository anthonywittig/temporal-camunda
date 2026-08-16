"""Generate the order-saga BPMN model, semantics + diagram interchange.

You would normally draw this in Camunda Modeler and commit the .bpmn file.
This script exists because the repo was built headless, and it keeps the model
reproducible: `npm run camunda:model` regenerates bpmn/order-saga.bpmn.

It also pins down two things that are easy to get wrong by hand and that
Modeler does for you silently:

  * the BPMN XSD fixes child order — extensionElements, then incoming/outgoing,
    then the event definition;
  * `bpmn:compensateEventDefinition` must carry an `id`. Without one, Zeebe 8.8
    rejects the whole deployment with a bare NullPointerException rather than a
    validation message.
"""
from xml.sax.saxutils import escape

NODES = {}   # id -> dict
EDGES = []   # list of dicts
ASSOCS = []  # compensation associations

def node(nid, kind, name, x, y, w, h, **kw):
    NODES[nid] = dict(id=nid, kind=kind, name=name, x=x, y=y, w=w, h=h, **kw)
    return nid

def edge(eid, src, tgt, waypoints, name=None, condition=None, default=False):
    EDGES.append(dict(id=eid, src=src, tgt=tgt, wp=waypoints, name=name,
                      condition=condition, default=default))

def assoc(aid, src, tgt, waypoints):
    ASSOCS.append(dict(id=aid, src=src, tgt=tgt, wp=waypoints))

# ---------------------------------------------------------------- geometry
TW, TH = 100, 80      # task
EW = 36               # event
GW = 50               # gateway

COMP_Y = 60           # compensation handler row      (center 100)
MAIN_Y = 240          # main flow row                 (center 280)
REVIEW_Y = 400        # human review branch           (center 440)
ERR_Y = 580           # error routing lane (center)

MAIN_C = MAIN_Y + TH // 2          # 280
COMP_C = COMP_Y + TH // 2          # 100
REVIEW_C = REVIEW_Y + TH // 2      # 440

# ---------------------------------------------------------------- main flow
node('StartEvent_1', 'startEvent', 'Order received', 152, MAIN_C - EW // 2, EW, EW)
node('Task_Inventory', 'serviceTask', 'Reserve inventory', 240, MAIN_Y, TW, TH, job='reserve-inventory')
node('Task_Payment', 'serviceTask', 'Authorize payment', 400, MAIN_Y, TW, TH, job='authorize-payment')
node('Task_Fraud', 'serviceTask', 'Screen for fraud', 560, MAIN_Y, TW, TH, job='screen-fraud')
node('Gateway_Risk', 'exclusiveGateway', 'High risk?', 720, MAIN_C - GW // 2, GW, GW)
node('Gateway_Join', 'exclusiveGateway', '', 1060, MAIN_C - GW // 2, GW, GW)
node('Task_Shipment', 'serviceTask', 'Create shipment', 1160, MAIN_Y, TW, TH, job='create-shipment')
node('Task_Capture', 'serviceTask', 'Capture payment', 1320, MAIN_Y, TW, TH, job='capture-payment')
node('EndEvent_Completed', 'endEvent', 'Completed', 1480, MAIN_C - EW // 2, EW, EW,
     outcome='completed')

# ------------------------------------------------- compensation handlers
node('Task_ReleaseInventory', 'serviceTask', 'Release inventory', 240, COMP_Y, TW, TH,
     job='release-inventory', compensation=True)
node('Task_VoidAuth', 'serviceTask', 'Void authorization', 400, COMP_Y, TW, TH,
     job='void-authorization', compensation=True)
node('Task_CancelShipment', 'serviceTask', 'Cancel shipment', 1160, COMP_Y, TW, TH,
     job='cancel-shipment', compensation=True)

# compensation boundary events sit on the TOP edge of their task
for bid, task in [('Boundary_Comp_Inventory', 'Task_Inventory'),
                  ('Boundary_Comp_Payment', 'Task_Payment'),
                  ('Boundary_Comp_Shipment', 'Task_Shipment')]:
    t = NODES[task]
    node(bid, 'boundaryEvent', '', t['x'] + 30, t['y'] - EW // 2, EW, EW,
         attached=task, event='compensate')

assoc('Association_Inventory', 'Boundary_Comp_Inventory', 'Task_ReleaseInventory',
      [(270 + EW // 2, MAIN_Y - EW // 2), (288, COMP_Y + TH)])
assoc('Association_Payment', 'Boundary_Comp_Payment', 'Task_VoidAuth',
      [(430 + EW // 2, MAIN_Y - EW // 2), (448, COMP_Y + TH)])
assoc('Association_Shipment', 'Boundary_Comp_Shipment', 'Task_CancelShipment',
      [(1190 + EW // 2, MAIN_Y - EW // 2), (1208, COMP_Y + TH)])

# --------------------------------------------------- human review branch
node('Task_Review', 'userTask', 'Fraud review', 790, REVIEW_Y, TW, TH)
node('Gateway_Approved', 'exclusiveGateway', 'Approved?', 950, REVIEW_C - GW // 2, GW, GW)
node('Throw_Comp_Rejected', 'intermediateThrowEvent', 'Undo order', 1052, REVIEW_C - EW // 2, EW, EW,
     event='compensate')
node('EndEvent_Rejected', 'endEvent', 'Rejected', 1150, REVIEW_C - EW // 2, EW, EW,
     outcome='rejected')

# ------------------------------------------------------- error routing
ERROR_TASKS = ['Task_Inventory', 'Task_Payment', 'Task_Fraud', 'Task_Shipment', 'Task_Capture']
for task in ERROR_TASKS:
    t = NODES[task]
    node(f'Boundary_Err_{task}', 'boundaryEvent', '', t['x'] + 62, t['y'] + TH - EW // 2, EW, EW,
         attached=task, event='error')

node('Gateway_Failed', 'exclusiveGateway', '', 1450, ERR_Y - GW // 2, GW, GW)
node('Throw_Comp_Failed', 'intermediateThrowEvent', 'Undo order', 1552, ERR_Y - EW // 2, EW, EW,
     event='compensate')
node('EndEvent_Failed', 'endEvent', 'Failed', 1650, ERR_Y - EW // 2, EW, EW,
     outcome='failed')

# ---------------------------------------------------------------- edges
def rc(nid):  # right-center
    n = NODES[nid]; return (n['x'] + n['w'], n['y'] + n['h'] // 2)
def lc(nid):  # left-center
    n = NODES[nid]; return (n['x'], n['y'] + n['h'] // 2)
def tc(nid):  # top-center
    n = NODES[nid]; return (n['x'] + n['w'] // 2, n['y'])
def bc(nid):  # bottom-center
    n = NODES[nid]; return (n['x'] + n['w'] // 2, n['y'] + n['h'])

edge('Flow_Start_Inventory', 'StartEvent_1', 'Task_Inventory', [rc('StartEvent_1'), lc('Task_Inventory')])
edge('Flow_Inventory_Payment', 'Task_Inventory', 'Task_Payment', [rc('Task_Inventory'), lc('Task_Payment')])
edge('Flow_Payment_Fraud', 'Task_Payment', 'Task_Fraud', [rc('Task_Payment'), lc('Task_Fraud')])
edge('Flow_Fraud_Gateway', 'Task_Fraud', 'Gateway_Risk', [rc('Task_Fraud'), lc('Gateway_Risk')])

# low risk: straight through (default flow)
edge('Flow_Risk_Low', 'Gateway_Risk', 'Gateway_Join', [rc('Gateway_Risk'), lc('Gateway_Join')],
     name='low risk', default=True)
# high risk: down into human review
edge('Flow_Risk_High', 'Gateway_Risk', 'Task_Review',
     [bc('Gateway_Risk'), (745, REVIEW_C), lc('Task_Review')],
     name='high risk', condition='=fraudRisk = "high"')
edge('Flow_Review_Gateway', 'Task_Review', 'Gateway_Approved', [rc('Task_Review'), lc('Gateway_Approved')])
edge('Flow_Approved', 'Gateway_Approved', 'Gateway_Join',
     [tc('Gateway_Approved'), (975, MAIN_C), lc('Gateway_Join')],
     name='approve', condition='=reviewDecision = "approve"')
edge('Flow_Rejected', 'Gateway_Approved', 'Throw_Comp_Rejected',
     [rc('Gateway_Approved'), lc('Throw_Comp_Rejected')], name='reject', default=True)
edge('Flow_Rejected_End', 'Throw_Comp_Rejected', 'EndEvent_Rejected',
     [rc('Throw_Comp_Rejected'), lc('EndEvent_Rejected')])

edge('Flow_Join_Shipment', 'Gateway_Join', 'Task_Shipment', [rc('Gateway_Join'), lc('Task_Shipment')])
edge('Flow_Shipment_Capture', 'Task_Shipment', 'Task_Capture', [rc('Task_Shipment'), lc('Task_Capture')])
edge('Flow_Capture_End', 'Task_Capture', 'EndEvent_Completed', [rc('Task_Capture'), lc('EndEvent_Completed')])

# error boundary events drop to the error lane and run right into the merge
for task in ERROR_TASKS:
    b = f'Boundary_Err_{task}'
    n = NODES[b]
    cx = n['x'] + EW // 2
    edge(f'Flow_Err_{task}', b, 'Gateway_Failed',
         [(cx, n['y'] + EW), (cx, ERR_Y), lc('Gateway_Failed')])

edge('Flow_Failed_Throw', 'Gateway_Failed', 'Throw_Comp_Failed',
     [rc('Gateway_Failed'), lc('Throw_Comp_Failed')])
edge('Flow_Failed_End', 'Throw_Comp_Failed', 'EndEvent_Failed',
     [rc('Throw_Comp_Failed'), lc('EndEvent_Failed')])

# ---------------------------------------------------------------- emit
inc = {nid: [] for nid in NODES}
out = {nid: [] for nid in NODES}
for e in EDGES:
    out[e['src']].append(e['id'])
    inc[e['tgt']].append(e['id'])

L = []
L.append('<?xml version="1.0" encoding="UTF-8"?>')
L.append('<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"')
L.append('                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"')
L.append('                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"')
L.append('                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"')
L.append('                  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"')
L.append('                  xmlns:modeler="http://camunda.org/schema/modeler/1.0"')
L.append('                  id="Definitions_OrderSaga" targetNamespace="http://bpmn.io/schema/bpmn"')
L.append('                  modeler:executionPlatform="Camunda Cloud"')
L.append('                  modeler:executionPlatformVersion="8.8.0">')
L.append('  <bpmn:error id="Error_StepFailed" name="Step failed" errorCode="STEP_FAILED" />')
L.append('  <bpmn:process id="order-saga" name="Order saga" isExecutable="true">')

default_flow = {e['src']: e['id'] for e in EDGES if e['default']}

for nid, n in NODES.items():
    kind = n['kind']
    attrs = f'id="{nid}"'
    if n['name']:
        attrs += f' name="{escape(n["name"])}"'
    if nid in default_flow:
        attrs += f' default="{default_flow[nid]}"'
    if n.get('compensation'):
        attrs += ' isForCompensation="true"'
    if kind == 'boundaryEvent':
        attrs += f' attachedToRef="{n["attached"]}"'
        if n['event'] == 'error':
            attrs += ' cancelActivity="true"'

    # The BPMN XSD fixes child order: extensionElements, then incoming/outgoing,
    # then the event definition. Deployment fails on anything else.
    ext = []
    if n.get('job'):
        ext.append(f'        <zeebe:taskDefinition type="{n["job"]}" retries="3" />')
    if kind == 'userTask':
        ext.append('        <zeebe:userTask />')
    if n.get('outcome'):
        # Output mapping so the terminal state is reported by the engine itself,
        # the same way the Temporal workflow returns an OrderResult.
        ext.append('        <zeebe:ioMapping>')
        ext.append(f'          <zeebe:output source="=&#34;{n["outcome"]}&#34;" target="outcome" />')
        ext.append('        </zeebe:ioMapping>')

    body = []
    if ext:
        body.append('      <bpmn:extensionElements>')
        body.extend(ext)
        body.append('      </bpmn:extensionElements>')

    # compensation handlers are triggered by association, never by sequence flow
    if not n.get('compensation'):
        for f in inc[nid]:
            body.append(f'      <bpmn:incoming>{f}</bpmn:incoming>')
        for f in out[nid]:
            body.append(f'      <bpmn:outgoing>{f}</bpmn:outgoing>')

    # NOTE: the id on compensateEventDefinition is load-bearing. Zeebe 8.8
    # dereferences it during deployment, and without one the broker rejects the
    # whole model with an opaque NullPointerException rather than a validation
    # error. Camunda Modeler always emits ids, so hand-written BPMN hits this.
    if n.get('event') == 'compensate':
        body.append(f'      <bpmn:compensateEventDefinition id="CompensateDef_{nid}" />')
    if n.get('event') == 'error':
        body.append(f'      <bpmn:errorEventDefinition id="ErrorDef_{nid}" errorRef="Error_StepFailed" />')

    if body:
        L.append(f'    <bpmn:{kind} {attrs}>')
        L.extend(body)
        L.append(f'    </bpmn:{kind}>')
    else:
        L.append(f'    <bpmn:{kind} {attrs} />')

for e in EDGES:
    attrs = f'id="{e["id"]}" sourceRef="{e["src"]}" targetRef="{e["tgt"]}"'
    if e['name']:
        attrs += f' name="{escape(e["name"])}"'
    if e['condition']:
        L.append(f'    <bpmn:sequenceFlow {attrs}>')
        L.append(f'      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression"'
                 f' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">{escape(e["condition"])}</bpmn:conditionExpression>')
        L.append('    </bpmn:sequenceFlow>')
    else:
        L.append(f'    <bpmn:sequenceFlow {attrs} />')

for a in ASSOCS:
    L.append(f'    <bpmn:association id="{a["id"]}" associationDirection="One"'
             f' sourceRef="{a["src"]}" targetRef="{a["tgt"]}" />')

L.append('  </bpmn:process>')

# ------------------------------------------------------------------ DI
L.append('  <bpmndi:BPMNDiagram id="BPMNDiagram_1">')
L.append('    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="order-saga">')
for nid, n in NODES.items():
    is_label = n['kind'] in ('startEvent', 'endEvent', 'boundaryEvent',
                             'intermediateThrowEvent', 'exclusiveGateway')
    L.append(f'      <bpmndi:BPMNShape id="{nid}_di" bpmnElement="{nid}">')
    L.append(f'        <dc:Bounds x="{n["x"]}" y="{n["y"]}" width="{n["w"]}" height="{n["h"]}" />')
    if is_label and n['name']:
        lx = n['x'] - 15
        ly = n['y'] + n['h'] + 5
        L.append('        <bpmndi:BPMNLabel>')
        L.append(f'          <dc:Bounds x="{lx}" y="{ly}" width="70" height="14" />')
        L.append('        </bpmndi:BPMNLabel>')
    L.append('      </bpmndi:BPMNShape>')

for e in EDGES:
    L.append(f'      <bpmndi:BPMNEdge id="{e["id"]}_di" bpmnElement="{e["id"]}">')
    for (x, y) in e['wp']:
        L.append(f'        <di:waypoint x="{x}" y="{y}" />')
    if e['name']:
        (x0, y0), (x1, y1) = e['wp'][0], e['wp'][1]
        if x0 == x1:
            # vertical first segment: sit the label beside the line, not on the
            # horizontal edge leaving the same gateway
            lx, ly = x0 + 8, y0 + 18
        else:
            lx, ly = x0 + 8, y0 - 20
        L.append('        <bpmndi:BPMNLabel>')
        L.append(f'          <dc:Bounds x="{lx}" y="{ly}" width="60" height="14" />')
        L.append('        </bpmndi:BPMNLabel>')
    L.append('      </bpmndi:BPMNEdge>')

for a in ASSOCS:
    L.append(f'      <bpmndi:BPMNEdge id="{a["id"]}_di" bpmnElement="{a["id"]}">')
    for (x, y) in a['wp']:
        L.append(f'        <di:waypoint x="{x}" y="{y}" />')
    L.append('      </bpmndi:BPMNEdge>')

L.append('    </bpmndi:BPMNPlane>')
L.append('  </bpmndi:BPMNDiagram>')
L.append('</bpmn:definitions>')

out_path = '/home/user/temporal-camunda/camunda/bpmn/order-saga.bpmn'
with open(out_path, 'w') as fh:
    fh.write('\n'.join(L) + '\n')
print(f'wrote {out_path}: {len(NODES)} nodes, {len(EDGES)} flows, {len(ASSOCS)} associations')
