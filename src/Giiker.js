import Base64 from 'base64-arraybuffer';

// Services
const CUBE_STATE_SERVICE = '0000aadb-0000-1000-8000-00805f9b34fb';
const CUBE_INFO_SERVICE = '0000aaaa-0000-1000-8000-00805f9b34fb';

// Characteristics
const CUBE_STATE_RESPONSE = '0000aadc-0000-1000-8000-00805f9b34fb';
const CUBE_INFO_RESPONSE = '0000aaab-0000-1000-8000-00805f9b34fb';
const CUBE_INFO_REQUEST = '0000aaac-0000-1000-8000-00805f9b34fb';

// Commands for cube info service
const WRITE_MOVE_COUNT = 0xCC;
const WRITE_RESET_SOLVED = 0xA1;
const WRITE_RESET_CUSTOM = 0xA4;
const WRITE_BATTERY = 0xB5;

// Charging possible states
const batteryStates = [
    { code: 1, description: 'Charged' },
    { code: 2, description: 'Charging' },
    { code: 3, description: 'Not Charging' }
];

// face indexes
const B = 0;
const D = 1;
const L = 2;
const U = 3;
const R = 4;
const F = 5;

const faces = ['B', 'D', 'L', 'U', 'R', 'F'];

// color indexes
const b = 0;
const y = 1;
const o = 2;
const w = 3;
const r = 4;
const g = 5;

const colors = ['blue', 'yellow', 'orange', 'white', 'red', 'green'];

const turns = {
    0: 1,
    1: 2,
    2: -1,
    8: -2,
};

const cornerColors = [
    [y, r, g],
    [r, w, g],
    [w, o, g],
    [o, y, g],
    [r, y, b],
    [w, r, b],
    [o, w, b],
    [y, o, b]
];

const cornerLocations = [
    [D, R, F],
    [R, U, F],
    [U, L, F],
    [L, D, F],
    [R, D, B],
    [U, R, B],
    [L, U, B],
    [D, L, B]
];

const edgeLocations = [
    [F, D],
    [F, R],
    [F, U],
    [F, L],
    [D, R],
    [U, R],
    [U, L],
    [D, L],
    [B, D],
    [B, R],
    [B, U],
    [B, L]
];

const edgeColors = [
    [g, y],
    [g, r],
    [g, w],
    [g, o],
    [y, r],
    [w, r],
    [w, o],
    [y, o],
    [b, y],
    [b, r],
    [b, w],
    [b, o]
];

class EventEmitter {
    constructor() {
        this.listeners = {};
    }

    on(label, callback) {
        if (!this.listeners[label]) {
            this.listeners[label] = [];
        }
        this.listeners[label].push(callback);
    }

    off(label, callback) {
        let listeners = this.listeners[label];

        if (listeners && listeners.length > 0) {
            let index = listeners.indexOf(callback);
            if (index > -1) {
                listeners.splice(index, 1);
                this.listeners[label] = listeners;
                return true;
            }
        }
        return false;
    }

    emit(label, ...args) {
        let listeners = this.listeners[label];

        if (listeners && listeners.length > 0) {
            listeners.forEach((listener) => {
                listener(...args);
            });
            return true;
        }
        return false;
    }
}

export default class Giiker extends EventEmitter {

    // Initialize default values
    constructor(device) {
        super();

        this._isConnected = false;
        this._state = {};
        this._device = device;
        this._services = [];
        this._stateService = null;
        this._infoService = null;
        this._stateServiceCharacteristics = [];
        this._infoServiceCharacteristics = [];
        this._cubeStateCharacteristic = null;

        // Sometimes the cube triggers a 'move' event right after connecting, which would emit a 'fake move event'
        // This flag is used to check if the first value (read before monitor the characteristic) is the same of the next one
        this._firstStateFlag = true;
    }

    // Connect to the device
    async connect() {
        this._device.connect().then((device) => {
            this.emit("connected");
            return device.discoverAllServicesAndCharacteristics()
        }).then((device) => {
            this._device = device;
            this._setup();
        }).catch((error) => {
            // Handle errors
            console.log(error);
            this.disconnect();
        });
    }

    /**
     * Disconnects from the GiiKER cube. Will fire the `disconnected` event once done.
     */
    disconnect() {
        if (!this._device) {
            return;
        }
        return this._device.cancelConnection();
    }

    // Get services and characteristics
    async _setup() {
        //get device services
        this._services = await this._device.services();

        // get main services
        this._stateService = this._services.find(srv => srv.uuid == CUBE_STATE_SERVICE);
        this._infoService = this._services.find(srv => srv.uuid == CUBE_INFO_SERVICE);

        // get service's characteristics
        this._stateServiceCharacteristics = await this._stateService.characteristics();
        this._infoServiceCharacteristics = await this._infoService.characteristics();

        // get cube state characteristic
        this._cubeStateCharacteristic = this._stateServiceCharacteristics.find(char => char.uuid == CUBE_STATE_RESPONSE);

        // read cube state
        const valuedCharacteristic = await this._cubeStateCharacteristic.read();

        // converts base64 to ArrayBuffer
        const arrayBuffer = Base64.decode(valuedCharacteristic.value);

        // parse cube value
        this._state = this._parseCubeValue(new DataView(arrayBuffer)).state;

        // handle moves on the cube
        this._cubeStateCharacteristic.monitor((error, characteristic) => {
            // Handle possible errors
            if (error) {
                console.log(error);
                return
            }

            // Verify if the 'fake move event' was triggered. If true, skip it
            if (this._firstStateFlag && valuedCharacteristic.value == characteristic.value) {
                this._firstStateFlag = false;
                return;
            } else {
                this._firstStateFlag = false;
            }

            const { state, moves } = this._parseCubeValue(new DataView(Base64.decode(characteristic.value)));
            this._state = state;
            this.emit('move', moves[0]);
        });

        // handle disconnection
        this._device.onDisconnected((error, device) => {
            this.emit("disconnected");
        });

        this.connected = true;
    }

    /**
     * Returns a promise that will resolve to the current battery level as percentage and the charging status
     * 
     * Note: Sometimes the cube returns value '184' in the first index (0) and the index 1 contains values 
     *       such as '160' or '161'. I don't know why it happens and what it means.
     *        
     *       When first index (0) return value '181' then the index 1 contains the right battery level.
     *       Maybe this should be filtered to avoid mistakes.
     */
    async getBatteryLevel() {
        const readCharacteristic = this._infoServiceCharacteristics.find(char => char.uuid == CUBE_INFO_RESPONSE);
        const writeCharacteristic = this._infoServiceCharacteristics.find(char => char.uuid == CUBE_INFO_REQUEST);

        writeCharacteristic.writeWithoutResponse(Base64.encode(new Uint8Array([WRITE_BATTERY])));

        return new Promise((resolve) => {
            const subscrition = readCharacteristic.monitor((error, characteristic) => {
                const value = new DataView(Base64.decode(characteristic.value));

                const batteryLevel = value.getUint8(1);
                const chargingState = batteryStates.find((state) => state.code == value.getUint8(2));

                resolve({ batteryLevel, chargingState });

                subscrition.remove();
            });
        });
    }

    /**
     * Returns a promise that will resolve to the total number of moves performed with this cube
     */
    async getMoveCount() {
        const readCharacteristic = this._infoServiceCharacteristics.find(char => char.uuid == CUBE_INFO_RESPONSE);
        const writeCharacteristic = this._infoServiceCharacteristics.find(char => char.uuid == CUBE_INFO_REQUEST);

        writeCharacteristic.writeWithoutResponse(Base64.encode(new Uint8Array([WRITE_MOVE_COUNT])));

        return new Promise((resolve) => {
            const subscrition = readCharacteristic.monitor((error, characteristic) => {
                console.log("teste");

                const value = new DataView(Base64.decode(characteristic.value));

                const moveCount = value.getUint8(4) +
                    (256 * value.getUint8(3)) +
                    (65536 * value.getUint8(2)) +
                    (16777216 * (value.getUint8(1)));

                console.log(moveCount);

                resolve(moveCount);
                subscrition.remove();
            });
        });
    }

    /**
     * Check if Giiker is connected
     */
    isConnected() {
        return this._isConnected;
    }

    /**
     * Reset the cube's internal state to solved
     */
    async resetSolved() {
        const writeCharacteristic = this._infoServiceCharacteristics.find(char => char.uuid == CUBE_INFO_REQUEST);

        await writeCharacteristic.writeWithoutResponse(Base64.encode(new Uint8Array([WRITE_RESET_SOLVED])));
    }

    _parseCubeValue(value) {
        const state = {
            cornerPositions: [],
            cornerOrientations: [],
            edgePositions: [],
            edgeOrientations: []
        };

        const moves = [];
        for (let i = 0; i < value.byteLength; i++) {
            const move = value.getUint8(i);

            const highNibble = move >> 4;
            const lowNibble = move & 0b1111;

            if (i < 4) {
                state.cornerPositions.push(highNibble, lowNibble);
            } else if (i < 8) {
                state.cornerOrientations.push(highNibble, lowNibble);
            } else if (i < 14) {
                state.edgePositions.push(highNibble, lowNibble);
            } else if (i < 16) {
                state.edgeOrientations.push(!!(move & 0b10000000));
                state.edgeOrientations.push(!!(move & 0b01000000));
                state.edgeOrientations.push(!!(move & 0b00100000));
                state.edgeOrientations.push(!!(move & 0b00010000));
                if (i === 14) {
                    state.edgeOrientations.push(!!(move & 0b00001000));
                    state.edgeOrientations.push(!!(move & 0b00000100));
                    state.edgeOrientations.push(!!(move & 0b00000010));
                    state.edgeOrientations.push(!!(move & 0b00000001));
                }
            } else {
                moves.push(this._parseMove(highNibble, lowNibble));
            }
        }

        return { state, moves };
    }

    _parseMove(faceIndex, turnIndex) {
        const face = faces[faceIndex - 1];
        const amount = turns[turnIndex - 1];
        let notation = face;

        switch (amount) {
            case 2: notation = `${face}2`; break;
            case -1: notation = `${face}'`; break;
            case -2: notation = `${face}2'`; break;
        }

        return { face, amount, notation };
    }

    _mapCornerColors(colors, orientation, position) {
        const actualColors = [];

        if (orientation !== 3) {
            if (position === 0 || position === 2 || position === 5 || position === 7) {
                orientation = 3 - orientation;
            }
        }

        switch (orientation) {
            case 1:
                actualColors[0] = colors[1];
                actualColors[1] = colors[2];
                actualColors[2] = colors[0];
                break;
            case 2:
                actualColors[0] = colors[2];
                actualColors[1] = colors[0];
                actualColors[2] = colors[1];
                break;
            case 3:
                actualColors[0] = colors[0];
                actualColors[1] = colors[1];
                actualColors[2] = colors[2];
                break;
        }

        return actualColors;
    }

    _mapEdgeColors(colors, orientation) {
        const actualColors = [...colors];
        if (orientation) {
            actualColors.reverse();
        }
        return actualColors;
    }

    /**
    * Returns the current state of the cube as arrays of corners and edges.
    *
    * Example how to interpret the state:
    *
    * Corner:
    * ```
    *   {
    *     position: ['D', 'R', 'F'],
    *     colors: ['yellow', 'red', 'green']
    *   }
    * ```
    * The corner in position DRF has the colors yellow on D, red on R and green ON F.
    *
    * Edge:
    * ```
    *   {
    *     position: ['F', 'U'],
    *     colors: ['green', 'white']
    *   }
    * ```
    * The edge in position FU has the colors green on F and white on U.
    */
    get state() {
        const state = {
            corners: [],
            edges: []
        };
        this._state.cornerPositions.forEach((cp, index) => {
            const mappedColors = this._mapCornerColors(
                cornerColors[cp - 1],
                this._state.cornerOrientations[index],
                index
            );
            state.corners.push({
                position: cornerLocations[index].map((f) => faces[f]),
                colors: mappedColors.map((c) => colors[c])
            });
        });
        this._state.edgePositions.forEach((ep, index) => {
            const mappedColors = this._mapEdgeColors(
                edgeColors[ep - 1],
                this._state.edgeOrientations[index]
            );
            state.edges.push({
                position: edgeLocations[index].map((f) => faces[f]),
                colors: mappedColors.map((c) => colors[c])
            });
        });
        return state;
    }

    /**
    * Returns the current state of the cube as a string compatible with cubejs.
    *
    * See https://github.com/ldez/cubejs#cubefromstringstr
    */
    get stateString() {
        const cornerFaceIndices = [
            [29, 15, 26],
            [9, 8, 20],
            [6, 38, 18],
            [44, 27, 24],
            [17, 35, 51],
            [2, 11, 45],
            [36, 0, 47],
            [33, 42, 53]
        ];

        const edgeFaceIndices = [
            [25, 28],
            [23, 12],
            [19, 7],
            [21, 41],
            [32, 16],
            [5, 10],
            [3, 37],
            [30, 43],
            [52, 34],
            [48, 14],
            [46, 1],
            [50, 39]
        ];

        const colorFaceMapping = {
            blue: 'B',
            yellow: 'D',
            orange: 'L',
            white: 'U',
            red: 'R',
            green: 'F'
        };

        const state = this.state;
        const faces = [];

        state.corners.forEach((corner, cornerIndex) => {
            corner.position.forEach((face, faceIndex) => {
                faces[cornerFaceIndices[cornerIndex][faceIndex]] = colorFaceMapping[corner.colors[faceIndex]];
            });
        });

        state.edges.forEach((edge, edgeIndex) => {
            edge.position.forEach((face, faceIndex) => {
                faces[edgeFaceIndices[edgeIndex][faceIndex]] = colorFaceMapping[edge.colors[faceIndex]];
            });
        });

        faces[4] = 'U';
        faces[13] = 'R';
        faces[22] = 'F';
        faces[31] = 'D';
        faces[40] = 'L';
        faces[49] = 'B';

        return faces.join('');
    }
}