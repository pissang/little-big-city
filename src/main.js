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
import JSZip from 'jszip';

const mvtCache = LRU(50);;

import distortion from './distortion';

const maptalks = require('maptalks');

let downloading = false;

const config = {
    radius: 60,
    curveness: 1,
    earthColor: '#c2ebb6',
    buildingsColor: '#fff',
    roadsColor: '#828282',
    waterColor: '#80a9d7',
    autoRotateSpeed: 0,
    sky: true,
    downloadOBJ: () => {
        if (downloading) {
            return;
        }
        const {obj, mtl} = toOBJ(app.scene, {
            mtllib: 'city'
        });
        const zip = new JSZip();
        zip.file('city.obj', obj);
        zip.file('city.mtl', mtl);
        zip.generateAsync({type: 'blob', compression: 'DEFLATE' })
            .then(content => {
                downloading = false;
                saveAs(content, 'city.zip');
            }).catch(e => {
                downloading = false;
                console.error(e.toString());
            });
        // Behind all processing in case some errror happens.
        downloading = true;
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
    depth: 2
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

        this._elementsNodes = {};
        this._elementsMaterials = {};
        vectorElements.forEach(el => {
            this._elementsNodes[el.type] = app.createNode();
            this._elementsMaterials[el.type] = app.createMaterial({
                name: 'mat_' + el.type,
                color: config[el.type + 'Color'],
                roughness: 1
            });
        });

        app.methods.updateEarthSphere();
        app.methods.updateElements();

        app.createAmbientCubemapLight('./asset/Grand_Canyon_C.hdr', 0.2, 0.8, 1).then(result => {
            const skybox = new plugin.Skybox({
                environmentMap: result.specular.cubemap,
                scene: app.scene
            });
            skybox.material.set('lod', 2);
            this._skybox = skybox;
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

            const earthMat = app.createMaterial({
                roughness: 1,
                color: config.earthColor,
                name: 'mat_earth'
            });

            faces.forEach((face, idx) => {
                const planeGeo = new builtinGeometries.Plane({
                    widthSegments: 20,
                    heightSegments: 20
                });
                app.createMesh(planeGeo, earthMat, this._earthNode);
                distortion(
                    planeGeo.attributes.position.value,
                    {x: -1, y: -1, width: 2, height: 2},
                    config.radius,
                    config.curveness,
                    face
                );
                planeGeo.generateVertexNormals();
            });

            this._advRenderer.render();
        },

        updateElements() {
            this._id = Math.random();

            const elementsNodes = this._elementsNodes;
            const elementsMaterials = this._elementsMaterials;
            for (let key in elementsNodes) {
                elementsNodes[key].removeAll();
            }

            function createElementMesh(elConfig, features, tile, idx) {
                const extent = tile.extent2d.convertTo(c => map.pointToCoord(c)).toJSON();
                const scale = 1e4;
                const result = extrudeGeoJSON({features: features}, {
                    translate: [-extent.xmin * scale, -extent.ymin * scale],
                    scale: [scale, scale],
                    lineWidth: 0.5,
                    excludeBottom: true,
                    simplify: 0.01,
                    depth: elConfig.depth
                });
                const boundingRect = {
                    x: 0, y: 0,
                    width: (extent.xmax - extent.xmin) * scale,
                    height: (extent.ymax - extent.ymin) * scale
                };
                const poly = result[elConfig.geometryType];
                const geo = new Geometry();
                geo.attributes.position.value = distortion(
                    poly.position, boundingRect,
                    config.radius, config.curveness, faces[idx]
                );
                geo.indices = poly.indices;
                geo.generateVertexNormals();
                geo.updateBoundingBox();

                app.createMesh(geo, elementsMaterials[elConfig.type], elementsNodes[elConfig.type]);
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
            for (let key in this._elementsMaterials) {
                this._elementsMaterials[key].set('color', config[key + 'Color']);
            }
            this._advRenderer.render();
        },

        render(app) {
            this._advRenderer.render();
        },

        updateAutoRotate() {
            this._control.autoRotateSpeed = config.autoRotateSpeed * 50;
            this._control.autoRotate = Math.abs(config.autoRotateSpeed) > 0.3;
        },

        updateSky(app) {
            config.sky ? this._skybox.attachScene(app.scene) : this._skybox.detachScene();
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
ui.add(config, 'radius', 30, 100).step(1).onChange(updateAll);
ui.add(config, 'autoRotateSpeed', -2, 2).step(0.01).onChange(app.methods.updateAutoRotate);
ui.add(config, 'sky').onChange(app.methods.updateSky);
ui.addColor(config, 'earthColor').onChange(app.methods.updateColor);
ui.addColor(config, 'buildingsColor').onChange(app.methods.updateColor);
ui.addColor(config, 'roadsColor').onChange(app.methods.updateColor);
ui.addColor(config, 'waterColor').onChange(app.methods.updateColor);
ui.add(config, 'downloadOBJ').onChange(app.methods.updateColor);
// ui.add(config, 'curveness', 0.01, 1).onChange(updateAll);

window.addEventListener('resize', () => { app.resize(); app.methods.render(); });