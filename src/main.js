/* global mapboxgl */
import {extrudeGeoJSON} from 'geometry-extrude';
import {application, plugin, geometry as builtinGeometries, Texture2D, Geometry} from 'claygl';
import {VectorTile} from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import * as dat from 'dat.gui';
import ClayAdvancedRenderer from 'claygl-advanced-renderer';
import LRU from 'lru-cache';
import quickhull from 'quickhull3d';
import toOBJ from './toOBJ';

const mvtCache = LRU(50);;

import distortion from './distortion';

const maptalks = require('maptalks');

const config = {
    size: 60,
    curveness: 1,
    earthColor: '#c2ebb6',
    buildingsColor: '#fff',
    roadsColor: '#828282',
    waterColor: '#80a9d7',
    downloadOBJ: () => {
        const {obj, mtl} = toOBJ(app.scene, {
            mtllib: 'city'
        });
        saveAs(new Blob([obj], {type: 'text/plain'}), 'city.obj');
        saveAs(new Blob([mtl], {type: 'text/plain'}), 'city.mtl');
    }
};

const mvtUrlTpl = 'https://tile.nextzen.org/tilezen/vector/v1/256/all/{z}/{x}/{y}.mvt?api_key=EWFsMD1DSEysLDWd2hj2cw';

const mainLayer = new maptalks.TileLayer('base', {
    tileSize: [256, 256],
    urlTemplate: 'http://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c']
});
const map = new maptalks.Map('map', {
    // center: [-0.113049, 51.498568],
    // center: [-73.97332, 40.76462],
    center: [-74.0130345, 40.70635160000003],
    zoom: 16,
    baseLayer: mainLayer
});
map.setMinZoom(16);
map.setMaxZoom(16);

const faces = [
    'pz', 'px', 'nz',
    'py', 'nx', 'ny'
];

const vectorElements = [{
    type: 'buildings',
    geometryType: 'polygon',
    depth: feature => {
        return (feature.properties.height || 30) / 10 + 1;
    }
}, {
    type: 'roads',
    geometryType: 'polyline',
    depth: 1
}, {
    type: 'water',
    geometryType: 'polygon',
    depth: 0.5
}];

const app = application.create('#viewport', {

    autoRender: false,

    init(app) {

        this._advRenderer = new ClayAdvancedRenderer(app.renderer, app.scene, app.timeline, {
            shadow: true,
            temporalSuperSampling: {
                enable: true,
                dynamic: false
            },
            postEffect: {
                enable: true,
                bloom: {
                    enable: false
                },
                screenSpaceAmbientOcclusion: {
                    enable: true,
                    intensity: 1.1,
                    radius: 5
                },
                FXAA: {
                    enable: true
                }
            }
        });
        this._advRenderer.setShadow({
            kernelSize: 10,
            blurSize: 3
        });

        const camera = app.createCamera([0, 0, 150], [0, 0, 0]);

        this._earthNode = app.createNode();
        this._cloudsNode = app.createNode();

        this._elementsNode = {};
        vectorElements.forEach(config => {
            this._elementsNode[config.type] = app.createNode();
        });

        app.methods.updateEarthSphere();
        app.methods.updateElements();

        app.createAmbientCubemapLight('./asset/Grand_Canyon_C.hdr', 0.2, 0.8, 1).then(result => {
            const skybox = new plugin.Skybox({
                environmentMap: result.specular.cubemap,
                scene: app.scene
            });
            skybox.material.set('lod', 2);
            this._advRenderer.render();
        });
        const light = app.createDirectionalLight([-1, -1, -1], '#fff');
        light.shadowResolution = 1024;
        light.shadowBias = 0.0005;

        this._control = new plugin.OrbitControl({
            target: camera,
            domElement: app.container,
            timeline: app.timeline,
            rotateSensitivity: 2
        });
        this._control.on('update', () => {
            this._advRenderer.render();
        });
        this._advRenderer.render();
    },

    methods: {
        updateEarthSphere(app) {
            this._earthNode.removeAll();

            faces.forEach((face, idx) => {
                const planeGeo = new builtinGeometries.Plane({
                    widthSegments: 20,
                    heightSegments: 20
                });
                const plane = app.createMesh(planeGeo, {
                    roughness: 1,
                    color: config.earthColor
                }, this._earthNode);
                distortion(
                    planeGeo.attributes.position.value,
                    {x: -1, y: -1, width: 2, height: 2},
                    config.size,
                    config.curveness,
                    face
                );
                planeGeo.generateVertexNormals();
            });

            this._advRenderer.render();
        },

        updateElements() {
            this._id = Math.random();

            const elementsNode = this._elementsNode;
            for (let key in elementsNode) {
                elementsNode[key].removeAll();
            }

            function createElementMesh(elementConfig, features, tile, idx) {
                const extent = tile.extent2d.convertTo(c => map.pointToCoord(c)).toJSON();
                const scale = 1e4;
                const result = extrudeGeoJSON({features: features}, {
                    translate: [-extent.xmin * scale, -extent.ymin * scale],
                    scale: [scale, scale],
                    lineWidth: 0.5,
                    excludeBottom: true,
                    simplify: 0.01,
                    depth: elementConfig.depth
                });
                const boundingRect = {
                    x: 0, y: 0,
                    width: (extent.xmax - extent.xmin) * scale,
                    height: (extent.ymax - extent.ymin) * scale
                };
                const poly = result[elementConfig.geometryType];
                const geo = new Geometry();
                geo.attributes.position.value = distortion(
                    poly.position, boundingRect,
                    config.size, config.curveness, faces[idx]
                );
                geo.indices = poly.indices;
                geo.generateVertexNormals();
                geo.updateBoundingBox();

                app.createMesh(geo, {
                    color: config[elementConfig.type + 'Color'],
                    roughness: 1
                }, elementsNode[elementConfig.type]);
            }

            const tiles = mainLayer.getTiles();

            tiles.tileGrids[0].tiles.forEach((tile, idx) => {
                const fetchId = this._id;
                if (idx >= 6) {
                    return;
                }
                const url = mvtUrlTpl.replace('{z}', tile.z)
                    .replace('{x}', tile.x)
                    .replace('{y}', tile.y);

                if (mvtCache.get(url)) {
                    const features = mvtCache.get(url);
                    for (let key in features) {
                        createElementMesh(
                            vectorElements.find(config => config.type === key),
                            features[key],
                            tile, idx
                        );
                    }
                }

                return fetch(url, {
                    mode: 'cors'
                }).then(response => response.arrayBuffer())
                    .then(buffer => {
                        if (fetchId !== this._id) {
                            return;
                        }

                        const pbf = new Protobuf(new Uint8Array(buffer));
                        const vTile = new VectorTile(pbf);
                        if (!vTile.layers.buildings) {
                            return;
                        }

                        const features = {};
                        ['buildings', 'roads', 'water'].forEach(type => {
                            if (!vTile.layers[type]) {
                                return;
                            }
                            features[type] = [];
                            for (let i = 0; i < vTile.layers[type].length; i++) {
                                const feature = vTile.layers[type].feature(i).toGeoJSON(tile.x, tile.y, tile.z);
                                features[type].push(feature);
                            }
                        });


                        mvtCache.set(url, features);
                        for (let key in features) {
                            createElementMesh(
                                vectorElements.find(config => config.type === key),
                                features[key],
                                tile, idx
                            );
                        }
                    });
            });
        },

        updateCloud() {
            const cloudNumber = 10;
            for (let i = 0; i < cloudNumber; i++) {

            }
        },

        updateColor() {
            this._earthNode.eachChild(mesh => {
                mesh.material.set('color', config.earthColor);
            });
            for (let key in this._elementsNode) {
                this._elementsNode[key].eachChild(mesh => {
                    mesh.material.set('color', config[key + 'Color']);
                });
            }
            this._advRenderer.render();
        },

        render() {
            this._advRenderer.render();
        }
    }
});

function updateAll() {
    app.methods.updateEarthSphere();
    app.methods.updateElements();
}

let timeout;
map.on('moveend', function () {
    clearTimeout(timeout);
    timeout = setTimeout(function () {
        app.methods.updateElements();
    }, 500);
});
map.on('zoomend', function () {
    clearTimeout(timeout);
    timeout = setTimeout(function () {
        app.methods.updateElements();
    }, 500);
});

const ui = new dat.GUI();
ui.add(config, 'size', 50, 200).step(1).onChange(updateAll);
ui.addColor(config, 'earthColor').onChange(app.methods.updateColor);
ui.addColor(config, 'buildingsColor').onChange(app.methods.updateColor);
ui.addColor(config, 'roadsColor').onChange(app.methods.updateColor);
ui.addColor(config, 'waterColor').onChange(app.methods.updateColor);
ui.add(config, 'downloadOBJ').onChange(app.methods.updateColor);
// ui.add(config, 'curveness', 0.01, 1).onChange(updateAll);

window.addEventListener('resize', () => { app.resize(); app.methods.render(); });