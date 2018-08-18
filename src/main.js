/* global mapboxgl */
import {extrudeGeoJSON, extrudePolygon} from 'geometry-extrude';
import {
    application,
    plugin,
    geometry as builtinGeometries,
    Texture2D,
    Geometry,
    Vector3
} from 'claygl';
import {VectorTile} from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import * as dat from 'dat.gui';
import ClayAdvancedRenderer from 'claygl-advanced-renderer';
import LRU from 'lru-cache';
import quickhull from 'quickhull3d';
import toOBJ from './toOBJ';
import JSZip from 'jszip';
import tessellate from './tessellate';
import vec2 from 'claygl/src/glmatrix/vec2';
import PolyBool from 'polybooljs';
import distortion from './distortion';

const mvtCache = LRU(50);

const maptalks = require('maptalks');

const DEFAULT_LNG = -74.0130345;
const DEFAULT_LAT = 40.7063516;

const DEFAULT_CONFIG = {
    radius: 60,
    curveness: 1,

    showEarth: true,
    earthDepth: 4,
    earthColor: '#c2ebb6',

    showBuildings: true,
    buildingsColor: '#fab8b8',

    showRoads: true,
    roadsColor: '#828282',

    showWater: true,
    waterColor: '#80a9d7',

    showCloud: true,
    cloudColor: '#fff',

    rotateSpeed: 0,
    sky: true
};

const searchStr = location.search.slice(1);
const searchItems = searchStr.split('&');
const urlOpts = {};
searchItems.forEach(item => {
    const arr = item.split('=');
    const key = arr[0];
    const val = arr[1] || true;
    urlOpts[key] = val;
});
urlOpts.lng = urlOpts.lng || DEFAULT_LNG;
urlOpts.lat = urlOpts.lat || DEFAULT_LAT;

function makeUrl() {
    const diffConfig = {};
    for (let key in config) {
        if (config[key] !== DEFAULT_CONFIG[key]) {
            diffConfig[key] = config[key];
        }
    }
    urlOpts.config = encodeURIComponent(JSON.stringify(diffConfig));

    const urlItems = [];
    for (let key in urlOpts) {
        urlItems.push(key + '=' + urlOpts[key]);
    }
    return './?' + urlItems.join('&');
}

const IS_TILE_STYLE = urlOpts.style === 'tile';

// const TILE_SIZE = IS_TILE_STYLE ? 512 : 256;
const TILE_SIZE = 256;

const config = Object.assign({}, DEFAULT_CONFIG);
try {
    Object.assign(config, JSON.parse(decodeURIComponent(urlOpts.config || '{}')));
}
catch (e) {}

const actions = {
    downloadOBJ: (() => {
        let downloading = false;
        return () => {
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
        };
    })(),
    randomCloud: () => {
        app.methods.generateClouds();
    },
    reset: () => {
        Object.assign(config, DEFAULT_CONFIG);
        ui.updateDisplay();
        window.location = makeUrl();
    }
};

const mvtUrlTpl = `https://{s}.tile.nextzen.org/tilezen/vector/v1/${TILE_SIZE}/all/{z}/{x}/{y}.mvt?api_key=EWFsMD1DSEysLDWd2hj2cw`;

const mainLayer = new maptalks.TileLayer('base', {
    tileSize: [TILE_SIZE, TILE_SIZE],
    urlTemplate: 'http://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c']
});
const map = new maptalks.Map('map-main', {
    // center: [-0.113049, 51.498568],
    // center: [-73.97332, 40.76462],
    center: [urlOpts.lng, urlOpts.lat],
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
    depth: 1.2
}, {
    type: 'water',
    geometryType: 'polygon',
    depth: 1
}];

function iterateFeatureCoordinates(feature, cb) {
    const geometry = feature.geometry;
    if (geometry.type === 'MultiPolygon') {
        for (let i = 0; i < geometry.coordinates.length; i++) {
            for (let k = 0; k < geometry.coordinates[i].length; k++) {
                geometry.coordinates[i][k] = cb(geometry.coordinates[i][k]);
            }
        }
    }
    else if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') {
        for (let i = 0; i < geometry.coordinates.length; i++) {
            geometry.coordinates[i] = cb(geometry.coordinates[i]);
        }
    }
    else if (geometry.type === 'LineString') {
        geometry.coordinates = cb(geometry.coordinates);
    }
}

function subdivideLongEdges(features, maxDist) {

    const v = [];
    function addPoints(points) {
        const newPoints = [];
        for (let i = 0; i < points.length - 1; i++) {
            vec2.sub(v, points[i + 1], points[i]);
            const dist = vec2.len(v);
            vec2.scale(v, v, 1 / dist);
            newPoints.push(points[i]);
            for (let d = maxDist; d < dist; d += maxDist) {
                newPoints.push(vec2.scaleAndAdd([], points[i], v, d));
            }
        }
        newPoints.push(points[points.length - 1]);
        return newPoints;
    }

    features.forEach(feature => {
        iterateFeatureCoordinates(feature, addPoints);
    });
}

function scaleFeature(feature, offset, scale) {
    function scalePoints(pts) {
        for (let i = 0; i < pts.length; i++) {
            pts[i][0] = (pts[i][0] + offset[0]) * scale[0];
            pts[i][1] = (pts[i][1] + offset[1]) * scale[1];
        }
        return pts;
    }
    iterateFeatureCoordinates(feature, scalePoints);
}

function unionComplexPolygons(features) {
    const mergedCoordinates = [];
    features.forEach(feature => {
        const geometry = feature.geometry;
        if (geometry.type === 'Polygon') {
            mergedCoordinates.push(feature.geometry.coordinates);
        }
        else if (geometry.type === 'MultiPolygon') {
            for (let i = 0; i < feature.geometry.coordinates.length; i++) {
                mergedCoordinates.push(feature.geometry.coordinates[i]);
            }
        }
    });
    const poly = PolyBool.polygonFromGeoJSON({
        type: 'MultiPolygon',
        coordinates: mergedCoordinates
    });
    return {
        type: 'Feature',
        properties: {},
        geometry: PolyBool.polygonToGeoJSON(poly)
    };
}

function cullBuildingPolygns(features) {
    const earthCoords = [getRectCoords(earthRect)];
    features.forEach(feature => {
        if (feature.geometry && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
            const poly = PolyBool.polygonFromGeoJSON(feature.geometry);
            const intersectedPoly = PolyBool.intersect(
                { regions: earthCoords, inverse: false },
                poly
            );
            feature.geometry = PolyBool.polygonToGeoJSON(intersectedPoly);
            if (!feature.geometry.coordinates.length) {
                feature.geometry = null;
            }
        }
    });
}

function unionRect(out, a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    out.x = x;
    out.y = y;
    out.width = Math.max(a.width + a.x, b.width + b.x) - x;
    out.height = Math.max(a.height + a.y, b.height + b.y) - y;
}

const width = 55;
const height = 58.5;
const earthRect = {
    x: -width / 2,
    y: -height / 2,
    width: width,
    height: height
};

function getRectCoords(rect) {
    return [
        [rect.x, rect.y],
        [rect.x + rect.width, rect.y],
        [rect.x + rect.width, rect.y + rect.height],
        [rect.x, rect.y + rect.height],
        [rect.x, rect.y]
    ];
}

const app = application.create('#viewport', {

    autoRender: false,

    devicePixelRatio: 1,

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
                    enable: false
                }
            }
        });
        this._advRenderer.setShadow({
            kernelSize: 10,
            blurSize: 3
        });

        const camera = app.createCamera([0, 0, 170], [0, 0, 0], IS_TILE_STYLE ? 'ortho' : 'perspective');
        if (IS_TILE_STYLE) {
            camera.top = 50;
            camera.bottom = -50;
            camera.left = -50 * app.renderer.getViewportAspect();
            camera.right = 50 * app.renderer.getViewportAspect();
            camera.near = 0;
            camera.far = 1000;
        }
        camera.update();
        this._camera = camera;

        this._earthNode = app.createNode();
        this._cloudsNode = app.createNode();

        this._elementsNodes = {};
        this._elementsMaterials = {};

        this._diffuseTex = app.loadTextureSync('./asset/paper-detail.png', {
            anisotropic: 8
        });

        vectorElements.forEach(el => {
            this._elementsNodes[el.type] = app.createNode();
            if (IS_TILE_STYLE) {
                this._elementsNodes[el.type].rotation.rotateX(-Math.PI / 2);
            }
            this._elementsMaterials[el.type] = app.createMaterial({
                diffuseMap: this._diffuseTex,
                uvRepeat: [10, 10],
                color: config[el.type + 'Color'],
                roughness: 1
            });
            this._elementsMaterials[el.type].name = 'mat_' + el.type;
        });

        const light = app.createDirectionalLight([-1, -1, -1], '#fff');
        light.shadowResolution = 2048;
        light.shadowBias = IS_TILE_STYLE ? 0.01 : 0.0005;

        this._control = new plugin.OrbitControl({
            target: camera,
            domElement: app.container,
            timeline: app.timeline,
            rotateSensitivity: 2,
            orthographicAspect: app.renderer.getViewportAspect()
        });
        if (IS_TILE_STYLE) {
            this._control.setOption({
                beta: 45,
                alpha: 30,
                minAlpha: 10,
                maxAlpha: 80
            });
        }
        this._control.on('update', () => {
            this._advRenderer.render();
        });

        if (!IS_TILE_STYLE) {
            app.methods.updateEarthSphere();
        }
        app.methods.updateElements();
        app.methods.updateVisibility();
        app.methods.generateClouds();

        this._advRenderer.render();


        return app.createAmbientCubemapLight('./asset/Grand_Canyon_C.hdr', 0.2, 0.8, 1).then(result => {
            const skybox = new plugin.Skybox({
                environmentMap: result.specular.cubemap,
                scene: app.scene
            });
            skybox.material.set('lod', 2);
            this._skybox = skybox;
            this._advRenderer.render();
        });
    },

    methods: {
        updateEarthSphere(app) {
            this._earthNode.removeAll();

            const earthMat = app.createMaterial({
                roughness: 1,
                color: config.earthColor,
                diffuseMap: this._diffuseTex,
                uvRepeat: [2, 2]
            });
            earthMat.name = 'mat_earth';

            faces.forEach(face => {
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

            this._cloudsNode.eachChild(cloudMesh => {
                const dist = cloudMesh.height + config.radius / Math.sqrt(2);
                cloudMesh.position.normalize().scale(dist);
            });

            this._advRenderer.render();
        },

        updateEarthGround(app, rect) {
            this._earthNode.removeAll();

            const {position, uv, normal, indices} = extrudePolygon(
                [[getRectCoords(earthRect)]], {
                    depth: config.earthDepth
                    // bevelSize: 0.3
                }
            );
            const geo = new Geometry();
            geo.attributes.position.value = position;
            geo.attributes.normal.value = normal;
            geo.attributes.texcoord0.value = uv;
            geo.indices = indices;
            geo.updateBoundingBox();
            const mesh = app.createMesh(geo, {
                nmae: 'mat_earth',
                roughness: 1,
                color: config.earthColor,
                diffuseMap: this._diffuseTex,
                uvRepeat: [2, 2]
            }, this._earthNode);
            mesh.rotation.rotateX(-Math.PI / 2);
            mesh.position.y = -config.earthDepth + 0.1;

            app.methods.render();
        },

        updateElements(app) {
            this._id = Math.random();
            const advRenderer = this._advRenderer;
            const elementsNodes = this._elementsNodes;
            const elementsMaterials = this._elementsMaterials;
            for (let key in elementsNodes) {
                elementsNodes[key].removeAll();
            }

            for (let key in this._buildingAnimators) {
                this._buildingAnimators[key].stop();
            }
            const buildingAnimators = this._buildingAnimators = {};

            function createElementMesh(elConfig, features, boundingRect, idx) {

                if (!IS_TILE_STYLE && elConfig.type === 'roads' || elConfig.type === 'water') {
                    subdivideLongEdges(features, 4);
                }
                const result = extrudeGeoJSON({features: features}, {
                    lineWidth: 0.5,
                    excludeBottom: true,
                    simplify: (IS_TILE_STYLE || elConfig.type === 'buildings') ? 0.01 : 0,
                    depth: elConfig.depth
                });
                const poly = result[elConfig.geometryType];
                const geo = new Geometry();
                if (!IS_TILE_STYLE && elConfig.type === 'water') {
                    const {indices, position} = tessellate(poly.position, poly.indices, 5);
                    poly.indices = indices;
                    poly.position = position;
                }
                geo.attributes.texcoord0.value = poly.uv;
                geo.indices = poly.indices;
                const mesh = app.createMesh(geo, elementsMaterials[elConfig.type], elementsNodes[elConfig.type]);
                if (elConfig.type === 'buildings') {
                    let positionAnimateFrom = new Float32Array(poly.position);
                    let positionAnimateTo = poly.position;
                    for (let i = 0; i < positionAnimateFrom.length; i += 3) {
                        const z = positionAnimateFrom[i + 2];
                        if (z > 0) {
                            positionAnimateFrom[i + 2] = 1;
                        }
                    }

                    if (!IS_TILE_STYLE) {
                        positionAnimateTo = distortion(
                            poly.position, boundingRect, config.radius, config.curveness, faces[idx]
                        );
                        positionAnimateFrom = distortion(
                            positionAnimateFrom, boundingRect, config.radius, config.curveness, faces[idx]
                        );
                    }
                    geo.attributes.position.value = positionAnimateTo;
                    geo.generateVertexNormals();
                    geo.updateBoundingBox();

                    const transitionPosition = new Float32Array(positionAnimateFrom);
                    geo.attributes.position.value = transitionPosition;

                    mesh.invisible = true;
                    const obj = {
                        p: 0
                    };
                    buildingAnimators[faces[idx]] = app.timeline.animate(obj)
                        .when(2000, {
                            p: 1
                        })
                        .delay(1000)
                        .during((obj, p) => {
                            mesh.invisible = false;
                            for (let i = 0; i < transitionPosition.length; i++) {
                                const a = positionAnimateFrom[i];
                                const b = positionAnimateTo[i];
                                transitionPosition[i] = (b - a) * p + a;
                            }
                            geo.dirty();
                            advRenderer.render();
                        })
                        .start('elasticOut');
                }
                else {
                    if (IS_TILE_STYLE) {
                        geo.attributes.position.value = poly.position;
                    }
                    else {
                        geo.attributes.position.value = distortion(
                            poly.position, boundingRect,
                            config.radius, config.curveness, faces[idx]
                        );
                    }
                    geo.generateVertexNormals();
                    geo.updateBoundingBox();
                }

                return {boundingRect: poly.boundingRect};
            }

            let tiles = mainLayer.getTiles().tileGrids[0].tiles;
            const subdomains = ['a', 'b', 'c'];
            if (IS_TILE_STYLE) {
                const center = map.getCenter();
                tiles = tiles.filter(tile => {
                    const extent = tile.extent2d.convertTo(c => map.pointToCoord(c)).toJSON();
                    return extent.xmax > center.x && extent.xmin < center.x
                        && extent.ymax > center.y && extent.ymin < center.y;
                });
            }
            let loading = Math.min(tiles.length, 6);
            tiles.forEach((tile, idx) => {
                const fetchId = this._id;
                if (idx >= 6) {
                    return;
                }
                const extent = tile.extent2d.convertTo(c => map.pointToCoord(c)).toJSON();

                const scaleX = 1e4;
                const scaleY = scaleX * 1.4;
                const width = (extent.xmax - extent.xmin) * scaleX;
                const height = (extent.ymax - extent.ymin) * scaleY;
                const tileRect = {
                    x: IS_TILE_STYLE ? -width / 2 : 0,
                    y: IS_TILE_STYLE ? -height / 2 : 0,
                    width: width,
                    height: height
                };
                const allBoundingRect = {
                    x: Infinity,
                    y: Infinity,
                    width: -Infinity,
                    height: -Infinity
                };

                const url = mvtUrlTpl.replace('{z}', tile.z)
                    .replace('{x}', tile.x)
                    .replace('{y}', tile.y)
                    .replace('{s}', subdomains[idx % 3]);

                if (mvtCache.get(url)) {
                    const features = mvtCache.get(url);
                    for (let key in features) {
                        createElementMesh(
                            vectorElements.find(config => config.type === key),
                            features[key],
                            tile, idx
                        );
                    }

                    return;
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
                                scaleFeature(
                                    feature, IS_TILE_STYLE
                                        ? [-(extent.xmax + extent.xmin) / 2, -(extent.ymax + extent.ymin) / 2]
                                        : [-extent.xmin, -extent.ymin]
                                    , [scaleX, scaleY]
                                );
                                features[type].push(feature);
                            }

                            if (IS_TILE_STYLE) {
                                cullBuildingPolygns(features[type]);
                            }
                        });

                        if (features.water) {
                            features.water = [unionComplexPolygons(features.water.filter(feature => {
                                const geoType = feature.geometry && feature.geometry.type;
                                return geoType === 'Polygon' || geoType === 'MultiPolygon';
                            }))];
                        }
                        features.roads = features.roads.filter(feature => {
                            const geoType = feature.geometry && feature.geometry.type;
                            return geoType === 'LineString' || geoType === 'MultiLineString';
                        });

                        mvtCache.set(url, features);
                        for (let key in features) {
                            const {boundingRect} = createElementMesh(
                                vectorElements.find(config => config.type === key),
                                features[key],
                                tileRect, idx
                            );
                            unionRect(allBoundingRect, boundingRect, allBoundingRect);
                        }

                        loading--;
                        if (IS_TILE_STYLE) {
                            if (loading === 0) {
                                app.methods.updateEarthGround(allBoundingRect);
                            }
                        }

                        app.methods.render();
                    });
            });
        },

        generateClouds(app) {
            const cloudNumber = IS_TILE_STYLE ? 10 : 15;
            const pointCount = 100;
            this._cloudsNode.removeAll();

            const cloudMaterial = app.createMaterial({
                roughness: 1,
                color: config.cloudColor
            });
            cloudMaterial.name = 'mat_cloud';

            function randomInSphere(r) {
                const alpha = Math.random() * Math.PI * 2;
                const beta = Math.random() * Math.PI;

                const r2 = Math.sin(beta) * r;
                const y = Math.cos(beta) * r;
                const x = Math.cos(alpha) * r2;
                const z = Math.sin(alpha) * r2;
                return [x, y, z];
            }
            for (let i = 0; i < cloudNumber; i++) {
                const positionArr = new Float32Array(5 * pointCount * 3);
                let off = 0;
                let indices = [];

                let dx = Math.random() - 0.5;
                let dy = Math.random() - 0.5;
                const len = Math.sqrt(dx * dx + dy * dy);
                dx /= len; dy /= len;

                const dist = 4 + Math.random() * 2;

                for (let i = 0; i < 5; i++) {
                    const posOff = (i - 2) + (Math.random() * 0.4 - 0.2);
                    const rBase = 3 - Math.abs(posOff);
                    const points = [];
                    const vertexOffset = off / 3;
                    for (let i = 0; i < pointCount; i++) {
                        const r = Math.random() * rBase + rBase;
                        const pt = randomInSphere(r);
                        points.push(pt);
                        positionArr[off++] = pt[0] + posOff * dist * dx;
                        if (IS_TILE_STYLE) {
                            positionArr[off++] = pt[1];
                            positionArr[off++] = pt[2] + posOff * dist * dy;
                        }
                        else {
                            positionArr[off++] = pt[1] + posOff * dist * dy;
                            positionArr[off++] = pt[2];
                        }
                    }
                    const tmp = quickhull(points);
                    for (let m = 0; m < tmp.length; m++) {
                        indices.push(tmp[m][0] + vertexOffset);
                        indices.push(tmp[m][1] + vertexOffset);
                        indices.push(tmp[m][2] + vertexOffset);
                    }
                }

                const geo = new Geometry();
                geo.attributes.position.value = positionArr;
                geo.initIndicesFromArray(indices);
                geo.generateFaceNormals();

                const cloudMesh = app.createMesh(geo, cloudMaterial, this._cloudsNode);
                cloudMesh.height = Math.random() * 10 + 20;
                if (IS_TILE_STYLE) {
                    cloudMesh.position.setArray([
                        (Math.random() - 0.5) * 60,
                        Math.random() * 10 + 25,
                        (Math.random() - 0.5) * 60
                    ]);
                    if (IS_TILE_STYLE) {
                        cloudMesh.scale.set(0.6, 0.6, 0.6);
                    }
                }
                else {
                    cloudMesh.position.setArray(randomInSphere(config.radius / Math.sqrt(2) + cloudMesh.height));
                    cloudMesh.lookAt(Vector3.ZERO);
                }
            }
            app.methods.render();
        },

        updateColor() {
            this._earthNode.eachChild(mesh => {
                mesh.material.set('color', config.earthColor);
            });
            this._cloudsNode.eachChild(mesh => {
                mesh.material.set('color', config.cloudColor);
            });
            for (let key in this._elementsMaterials) {
                this._elementsMaterials[key].set('color', config[key + 'Color']);
            }
            this._advRenderer.render();
        },

        render(app) {
            this._control.orthographicAspect = app.renderer.getViewportAspect();
            this._advRenderer.render();
            // TODO
            setTimeout(() => {
                this._advRenderer.render();
            }, 20);
        },

        updateAutoRotate() {
            this._control.rotateSpeed = config.rotateSpeed * 50;
            this._control.autoRotate = Math.abs(config.rotateSpeed) > 0.3;
        },

        updateSky(app) {
            config.sky ? this._skybox.attachScene(app.scene) : this._skybox.detachScene();
            this._advRenderer.render();
        },

        updateVisibility(app) {
            this._earthNode.invisible = !config.showEarth;
            this._cloudsNode.invisible = !config.showCloud;

            this._elementsNodes.buildings.invisible = !config.showBuildings;
            this._elementsNodes.roads.invisible = !config.showRoads;
            this._elementsNodes.water.invisible = !config.showWater;

            app.methods.render();
        }
    }
});

function updateAll() {
    if (!IS_TILE_STYLE) {
        app.methods.updateEarthSphere();
    }
    app.methods.updateElements();
}

function updateUrlState() {
    history.pushState('', '', makeUrl());
}

let timeout;
map.on('moveend', function () {
    clearTimeout(timeout);
    timeout = setTimeout(function () {
        app.methods.updateElements();
        updateUrlState();
    }, 500);
});
map.on('moving', function () {
    const center = map.getCenter();
    urlOpts.lng = document.querySelector('#lng').value = center.x;
    urlOpts.lat = document.querySelector('#lat').value = center.y;
});
map.on('zoomend', function () {
    clearTimeout(timeout);
    timeout = setTimeout(function () {
        app.methods.updateElements();
    }, 500);
});

Array.prototype.forEach.call(document.querySelectorAll('#style-list li'), li => {
    li.addEventListener('click', () => {
        urlOpts.style = li.className;
        window.location = makeUrl();
    });
});

document.querySelector('#locate').addEventListener('click', () => {
    urlOpts.lng = +document.querySelector('#lng').value;
    urlOpts.lat = +document.querySelector('#lat').value;
    map.setCenter({x: urlOpts.lng, y: urlOpts.lat});
    app.methods.updateElements();
    updateUrlState();
});

document.querySelector('#reset').addEventListener('click', () => {
    urlOpts.lng = document.querySelector('#lng').value = DEFAULT_LNG;
    urlOpts.lat = document.querySelector('#lat').value = DEFAULT_LAT;
    map.setCenter({x: urlOpts.lng, y: urlOpts.lat});
    app.methods.updateElements();
    updateUrlState();
});

const ui = new dat.GUI();
ui.add(actions, 'reset');
if (!IS_TILE_STYLE) {
    ui.add(config, 'radius', 30, 100).step(1).onChange(updateAll).onFinishChange(updateUrlState);
}
ui.add(config, 'rotateSpeed', -2, 2).step(0.01).onChange(app.methods.updateAutoRotate).onFinishChange(updateUrlState);
ui.add(config, 'sky').onChange(app.methods.updateSky).onFinishChange(updateUrlState);

const earthFolder = ui.addFolder('Earth');
earthFolder.add(config, 'showEarth').onChange(app.methods.updateVisibility).onFinishChange(updateUrlState);
if (IS_TILE_STYLE) {
    earthFolder.add(config, 'earthDepth', 1, 50).onChange(app.methods.updateEarthGround).onFinishChange(updateUrlState);
}
earthFolder.addColor(config, 'earthColor').onChange(app.methods.updateColor).onFinishChange(updateUrlState);

const buildingsFolder = ui.addFolder('Buildings');
buildingsFolder.add(config, 'showBuildings').onChange(app.methods.updateVisibility).onFinishChange(updateUrlState);
buildingsFolder.addColor(config, 'buildingsColor').onChange(app.methods.updateColor).onFinishChange(updateUrlState);

const roadsFolder = ui.addFolder('Roads');
roadsFolder.add(config, 'showRoads').onChange(app.methods.updateVisibility).onFinishChange(updateUrlState);
roadsFolder.addColor(config, 'roadsColor').onChange(app.methods.updateColor).onFinishChange(updateUrlState);

const waterFolder = ui.addFolder('Water');
waterFolder.add(config, 'showWater').onChange(app.methods.updateVisibility).onFinishChange(updateUrlState);
waterFolder.addColor(config, 'waterColor').onChange(app.methods.updateColor).onFinishChange(updateUrlState);

const cloudFolder = ui.addFolder('Cloud');
cloudFolder.add(config, 'showCloud').onChange(app.methods.updateVisibility).onFinishChange(updateUrlState);
cloudFolder.addColor(config, 'cloudColor').onChange(app.methods.updateColor).onFinishChange(updateUrlState);
cloudFolder.add(actions, 'randomCloud');

ui.add(actions, 'downloadOBJ');

window.addEventListener('resize', () => { app.resize(); app.methods.render(); });
