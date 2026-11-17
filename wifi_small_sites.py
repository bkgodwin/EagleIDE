"""Meter-based layouts for the clinic, floor-12 suite, and modern house."""

from dataclasses import dataclass, field


@dataclass
class Plan:
    walls: list = field(default_factory=list)
    labels: list = field(default_factory=list)
    furniture: list = field(default_factory=list)
    surfaces: list = field(default_factory=list)
    equipment: list = field(default_factory=list)

    @staticmethod
    def door(at, width=1, finish='wood'):
        return 'door', finish, at, width

    @staticmethod
    def window(at, width=2.25, finish='glass'):
        return 'window', finish, at, width

    def horizontal(self, name, left, right, y, *cuts, material='drywall'):
        self.walls.append((name, (left, y), (right, y), material,
                           *((kind, finish, at - left, width) for kind, finish, at, width in cuts)))

    def vertical(self, name, x, top, bottom, *cuts, material='drywall'):
        self.walls.append((name, (x, top), (x, bottom), material,
                           *((kind, finish, at - top, width) for kind, finish, at, width in cuts)))

    def room(self, name, left, top, right, bottom, color='#e3ebed'):
        self.fill('floor', color, left, top, right, bottom)
        self.labels.append((left + .5, top + .8, name))

    def fill(self, kind, color, left, top, right, bottom):
        self.surfaces.append((kind, color, left, top, right, bottom))

    def place(self, kind, x, y, angle=0):
        self.furniture.append((kind, x, y, angle))

    def desk(self, x, y, angle=0):
        self.place('desk', x, y, angle)
        self.place('chair', x, y + .78 if angle == 0 else y - .78, angle)

    def result(self):
        return self.walls, self.labels, self.furniture, self.surfaces, self.equipment


def clinic_layout():
    p = Plan()
    h, v, d, glass = p.horizontal, p.vertical, p.door, p.window
    brick = 'brick'
    p.labels.append((.5, 15.1, 'Patient entrance'))
    h('clinic-north', 0, 20, 0, *(glass(x) for x in (2.2, 7.2, 12.7, 17.5)), material=brick)
    h('clinic-south', 0, 20, 13, glass(2.2), d(4.7, 1.9, 'glass'), glass(15.4), material=brick)
    v('clinic-west', 0, 0, 13, glass(9.7), material=brick)
    v('clinic-east', 20, 0, 13, d(6.1, 1.2, 'metal'), material=brick)
    h('clinic-exam-corridor', 0, 20, 5, *(d(x, 1.15) for x in (2.6, 7.6, 12.2, 17.4)))
    h('clinic-front-corridor', 0, 20, 7.3, d(4.5, 1.3, 'glass'), d(8.1), d(12.1), d(15), d(18))
    p.room('Clinical corridor', 0, 5, 20, 7.3, '#f0ede2')
    for i, (name, left, right) in enumerate((
        ('Exam 1', 0, 5), ('Exam 2', 5, 10), ('Doctor consultation', 10, 15.2), ('Treatment', 15.2, 20),
    )):
        if i:
            v(f'clinic-exam-{i}', left, 0, 5)
        p.room(name, left, 0, right, 5, '#dcebe7')
        if i == 2:
            p.desk(12.6, 2.5)
            p.place('chair', 12.6, 1.65, 180)
        else:
            p.place('hospital_bed', left + 1.25, 2.8)
            p.place('counter', right - 1.1, 1.15)
            p.place('chair', right - 1.15, 3.65)

    for i, (name, left, right) in enumerate((
        ('Waiting', 0, 6), ('Reception', 6, 10.6), ('Patient WC', 10.6, 13.7),
        ('Clean utility', 13.7, 16.2), ('Staff break', 16.2, 20),
    )):
        if i:
            v(f'clinic-front-{i}', left, 7.3, 13, *((
                d(9.8, 1.6, 'glass'),
            ) if i == 1 else ()))
        p.room(name, left, 7.3, right, 13, '#e9e6d9' if i < 2 else '#e7e8eb')
    for y in (9, 10.05, 11.1):
        p.place('chair', .7, y, 90)
    p.place('sofa', 2.1, 12.25)
    p.place('counter', 6.55, 9.8, 90)
    p.desk(8.55, 10.2)
    p.place('toilet', 12.8, 11.9, 180)
    p.place('counter', 15, 11.9)
    p.place('table', 18, 10.2)
    p.place('chair', 18, 11)
    p.fill('sidewalk', '#e6ddcd', -1, 13, 21, 16)
    p.fill('pavement', '#9ba8ac', -1, 16, 21, 28)
    p.fill('landscape', '#cbdcbe', -3, -2, -1, 16)
    p.place('parking_row', 10.8, 18.6)
    p.place('car', 7.05, 18.6)
    p.place('car', 14.55, 18.6, 180)
    p.place('tree', -.6, 14.6)
    p.place('bench', 17.3, 14.4)
    return p.result()


def highrise_suite_layout():
    p = Plan()
    h, v, d, glass = p.horizontal, p.vertical, p.door, p.window
    concrete = 'reinforced_concrete'
    p.labels.append((.8, -2.0, 'Twelfth floor · South wing'))
    divisions = (7, 10.6, 14.2, 17.8, 21.4, 25, 28.6)
    centers = [(left + right) / 2 for left, right in zip(divisions, divisions[1:])]
    h('suite-north', 0, 31.5, 0, *(glass(x, 2.55, 'coated_glass') for x in centers), material=concrete)
    h('suite-south', 0, 31.5, 21, *(glass(x, 2.55, 'coated_glass') for x in centers), material=concrete)
    v('suite-west', 0, 0, 21, material=concrete)
    v('suite-east', 31.5, 0, 21, *(glass(y, 2.4, 'coated_glass') for y in (7.0, 14.0)), material=concrete)
    h('suite-north-office-hall', 7, 28.6, 5.6, *(d(x) for x in centers))
    h('suite-south-office-hall', 7, 28.6, 15.4, *(d(x) for x in centers))
    for row, (top, bottom, offset) in enumerate(((0, 5.6, 0), (15.4, 21, 6))):
        for i, (left, right) in enumerate(zip(divisions, divisions[1:]), 1):
            v(f'suite-office-{offset + i}', right, top, bottom)
            p.room(f'Office {offset + i:02d}', left, top, right, bottom, '#dee9ed' if row == 0 else '#e8e3ee')
            p.desk((left + right) / 2, top + 2.7)
            p.place('counter', right - .55, bottom - 1.25, 90)

    # Two corridors connect around the east of the meeting and support core.
    p.fill('floor', '#f0ebe0', 7, 5.6, 31.5, 15.4)
    p.fill('floor', '#f0ebe0', 28.6, 0, 31.5, 5.6)
    p.fill('floor', '#f0ebe0', 28.6, 15.4, 31.5, 21)
    p.place('bench', 30.05, 1.25)
    p.place('bench', 30.05, 19.75)
    h('suite-core-north', 7, 27.7, 8.5, d(14.2, 1.35, 'glass'), d(20.7), d(25.6, 1, 'metal'))
    h('suite-core-south', 7, 27.7, 12.6, d(9.2, 1))
    for i, (name, left, right) in enumerate((
        ('Copy & files', 7, 11), ('Meeting room', 11, 18), ('Break room', 18, 23.4), ('IT / riser', 23.4, 27.7),
    )):
        v(f'suite-service-{i}', right, 8.5, 12.6, material=concrete if i >= 2 else 'drywall')
        p.room(name, left, 8.5, right, 12.6, '#e6e9dc' if i == 2 else '#dfe4ea')
    p.place('conference_table', 14.5, 10.85)
    p.place('cafeteria_table', 20.6, 11.25)
    p.place('counter', 8.5, 9.05)
    p.place('counter', 21.6, 9.05)

    # The reinforced shared core sits outside the tenant's reception door.
    v('suite-core-fire-wall', 7, 0, 21, d(6.9, 1.65, 'glass'), d(14.05, 1.3, 'metal'), material=concrete)
    h('suite-stair-fire-wall', 0, 7, 4.8, d(2.1, 1.2, 'metal'), material=concrete)
    h('suite-elevator-line', 1.55, 7, 10.4, d(2.8, 1.05, 'metal'), d(5.55, 1.05, 'metal'), material=concrete)
    h('suite-elevator-shaft-south', 1.55, 7, 13, material=concrete)
    v('suite-elevator-shaft-divider', 4.25, 10.4, 13, material=concrete)
    h('suite-restroom-hall', 0, 7, 15.4, d(1.4), d(5.1))
    v('suite-restroom-divider', 3.5, 15.4, 21)
    p.room('Stair landing', 0, 0, 7, 4.8, '#d8dee1')
    p.room('Elevator lobby', 0, 4.8, 7, 10.4, '#eee2d1')
    p.room('Elevator A', 1.55, 10.4, 4.25, 13, '#c5cfd4')
    p.room('Elevator B', 4.25, 10.4, 7, 13, '#c5cfd4')
    p.room('Restrooms', 0, 15.4, 3.5, 21, '#dbe9ef')
    p.room('Accessible WC', 3.5, 15.4, 7, 21, '#dbe9ef')
    p.fill('floor', '#efe9de', 0, 13, 7, 15.4)
    # Public restroom access bypasses the elevator shafts at the west landing.
    v('suite-core-return', 1.55, 10.4, 13, material=concrete)
    p.fill('floor', '#efe9de', 0, 10.4, 1.55, 13)
    p.place('sofa', 4.9, 5.5, 180)
    p.place('counter', 8.35, 7.9)
    p.labels.append((9.9, 7.45, 'Reception'))
    p.place('toilet', 2.5, 19.7, 180)
    p.place('toilet', 6.0, 19.7, 180)
    for x in (1.25, 1.7, 2.15, 2.6, 4.4, 4.85, 5.3, 5.75):
        p.fill('floor', '#adbdc4', x, 1.75, x + .12, 3.8)
    return p.result()


def modern_house_layout():
    p = Plan()
    h, v, d, glass = p.horizontal, p.vertical, p.door, p.window
    outer, wood, tile = 'brick', '#eaddc9', '#dce8eb'
    p.labels.extend([(10.2, 20.4, 'Front porch'), (-10.4, 21, 'Garage drive'), (18, 21.8, 'Covered patio')])
    p.fill('landscape', '#d2e3c5', -14, -8, 30, 27)
    p.fill('pavement', '#a7aead', -11, 18.5, -3, 27)
    p.fill('sidewalk', '#e5ded1', -3, 16, 0, 18)
    p.fill('sidewalk', '#e5ded1', -1.8, 9.6, 0, 16)
    p.fill('sidewalk', '#e5ded1', 9.8, 18, 15, 22)
    p.fill('sidewalk', '#ddd5c4', 17, 18, 28, 23.5)
    for x, y in ((-11.5, -5), (-5, 2), (5, -4.7), (12, -4.7), (28, 7.5), (28, -2), (3.0, 24)):
        p.place('tree', x, y)
    h('home-north', 0, 27, 0, *(glass(x) for x in (2.3, 7, 11.7, 15.5, 21)), material=outer)
    h('home-south', 0, 27, 18, glass(3), glass(8.3), d(12.4, 1.35, 'glass'), glass(18.2, 3.2),
      d(24.1, 2.8, 'glass'), material=outer)
    v('home-west', 0, 0, 18, d(10.4, 1.1, 'wood'), glass(14.65), material=outer)
    v('home-east', 27, 0, 18, glass(4.9, 1.4), glass(11.5, 3), glass(15.3, 2), material=outer)
    h('home-bedroom-hall', 0, 27, 7, *(d(x) for x in (3.65, 8.3, 12.65, 16, 22.9)))
    p.room('Bedroom hall', 0, 7, 27, 9, '#f1e9da')
    for i, (left, right, bed) in enumerate(((0, 4.7, 2.2), (4.7, 9.4, 7.05), (9.4, 14, 11.7)), 2):
        v(f'home-bedroom-{i}', right, 0, 7)
        p.room(f'Bedroom {i}', left, 0, right, 7, '#e4e8eb')
        p.place('bed', bed, 2.7)
        p.desk(left + 1.35, 5.7)
    v('home-primary-divider', 17.5, 0, 7)
    v('home-primary-suite', 24, 0, 7, d(2.7, .9), d(5.4, .9))
    h('home-primary-utility', 24, 27, 3.8)
    p.room('Hall bath', 14, 0, 17.5, 7, tile)
    p.place('tub', 15.7, 1.6)
    p.place('toilet', 16.6, 4.2, 180)
    p.fill('floor', '#e7e1ec', 17.5, 0, 24, 7)
    p.labels.insert(3, (18.75, .85, 'Primary bedroom'))
    p.place('bed', 20.6, 2.8)
    p.place('counter', 22.8, 1.4)
    p.room('En suite', 24, 0, 27, 3.8, tile)
    p.place('toilet', 26.3, 2.65)
    p.room('Walk-in', 24, 3.8, 27, 7, '#e9e3db')
    p.place('counter', 26.2, 5.7, 90)

    h('home-south-hall', 0, 14.8, 9, d(4.5, 1.1), d(9.4), d(12.4, 1.6, 'none'))
    v('home-game-office', 6.15, 9, 18)
    v('home-office-foyer', 10.8, 9, 18)
    v('home-foyer-living', 14.8, 9, 18, d(13.9, 2.4, 'none'))
    h('home-mud-partition', 0, 3.1, 11.9, d(2.15))
    v('home-mud-end', 3.1, 9, 11.9)
    p.room('Game room', 0, 9, 6.15, 18, '#e2dfed')
    p.room('Mudroom', 0, 9, 3.1, 11.9, tile)
    p.place('sofa', 3, 16.3)
    p.place('counter', 3, 12.6)
    p.room('Home office', 6.15, 9, 10.8, 18, '#e0e9ee')
    p.desk(8.35, 14.65)
    p.room('Foyer', 10.8, 9, 14.8, 18, wood)
    p.place('bench', 11.35, 16.2, 90)
    p.room('Kitchen & dining', 14.8, 7, 27, 13.15, '#ede7d3')
    p.room('Living room', 14.8, 13.15, 27, 18, wood)
    for x in (18.2, 20, 21.8):
        p.place('counter', x, 7.65)
    p.place('table', 19.4, 9.55)
    p.place('cafeteria_table', 24, 10.9)
    p.place('sofa', 21.65, 14.65, 180)
    p.place('table', 21.65, 16.05)
    p.place('counter', 19.7, 17.45)
    p.place('cafeteria_table', 21, 20.65)
    p.place('bench', 26.6, 22.6)

    h('garage-north', -11, -3, 10, glass(-7, 2.3), material=outer)
    h('garage-south', -11, -3, 18.5, d(-7, 5.5, 'metal'), material=outer)
    v('garage-west', -11, 10, 18.5, material=outer)
    v('garage-east', -3, 10, 18.5, d(16.9), material=outer)
    p.room('Detached two-car garage', -11, 10, -3, 18.5, '#d7dde0')
    p.place('car', -8.9, 14.95, 180)
    p.place('car', -5.15, 14.95, 0)
    p.place('counter', -7, 10.75)

    def client(kind, ident, name, x, y, **config):
        p.equipment.append(dict(id=ident, kind=kind, name=name, x=x, y=y, **config))

    client('smart_tv', 'living-tv', 'Living room TV', 19.7, 17.45)
    client('smart_tv', 'game-tv', 'Game room TV', 2.4, 12.6)
    client('game_console', 'game-console', 'Game console', 3.8, 12.6)
    client('smart_speaker', 'kitchen-speaker', 'Kitchen speaker', 20, 7.65)
    client('smart_speaker', 'bedroom-speaker', 'Bedroom speaker', 22.8, 1.4)
    client('desktop', 'home-desktop', 'Home office desktop', 8.35, 14.65)
    client('desktop', 'study-desktop', 'Bedroom 3 desktop', 6.05, 5.7)
    client('phone', 'kitchen-phone', 'Phone · kitchen', 24, 10.15)
    client('phone', 'bedroom-phone', 'Phone · primary suite', 21.8, 3.5)
    client('poe_camera', 'porch-cam', 'Front porch camera', 14.2, 18.3, angle=92, range=11, field_of_view=80)
    client('poe_camera', 'garage-cam', 'Garage drive camera', -7.1, 18.8, angle=90, range=10, field_of_view=85)
    for name, wall, t in (('Porch lights', 'home-foyer-living', .26), ('Game room lights', 'home-game-office', .19),
                          ('Garage lights', 'garage-east', .58)):
        p.equipment.append(dict(id=f'light-{wall}', kind='smart_light_switch', name=name, wall_id=wall, t=t))
    return p.result()
