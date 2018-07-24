import {Vector3} from 'claygl';
var CREDIT = '# https://github.com/pissang/little-big-city\n';

function quantizeArr(out, arr, precision) {
    out[0] = Math.round(arr[0] * precision) / precision;
    out[1] = Math.round(arr[1] * precision) / precision;
    if (arr.length > 2) {
        out[2] = Math.round(arr[2] * precision) / precision;
    }
}

function phongFromRoughness(r) {
    if (r == null) {
        r = 1;
    }
    return Math.pow(1000.0, 1 - r);
}

function getMaterialParameters(material) {
    var obj = {};
    obj['Kd'] = (material.get('color') || [1, 1, 1]).slice(0, 3).join(' ');
    // TODO
    obj['Ks'] = [1, 1, 1].join(' ');
    obj['Ns'] = phongFromRoughness(material.get('roughness'));

    // Physically-based Rendering extension.
    if (material.shader.name === 'ecgl.realistic') {
        if (material.get('metalness') != null) {
            obj['Pm'] = material.get('metalness');
        }
        if (material.get('roughness') != null) {
            obj['Pr'] = material.get('roughness');
        }
    }
    return obj;
}

/**
 * @param {clay.Scene} scene
 * @param {Object} [opts]
 * @param {string} [opts.mtllib='']
 */
export default function exportGL2OBJ(scene, opts) {
    opts = opts || {};
    opts.storeVertexColorInTexture = opts.storeVertexColorInTexture || false;
    opts.mtllib = opts.mtllib || 'material';

    let objStr = CREDIT;
    objStr += 'mtllib ' + opts.mtllib + '.mtl\n';

    let materialLib = {};
    let textureLib = {};
    let indexStart = 1;
    scene.traverse(function (mesh) {
        let parent = mesh;
        while (parent) {
            if (parent.invisible) {
                return;
            }
            parent = parent.getParent();
        }

        if (mesh.isRenderable() && mesh.geometry.vertexCount) {
            let materialName = mesh.material.name;
            objStr += 'o ' + mesh.name + '\n';

            materialLib[materialName] = getMaterialParameters(mesh.material, textureLib);

            let vStr = [];
            let vtStr = [];
            let vnStr = [];

            let geometry = mesh.geometry;
            let positionAttr = geometry.attributes.position;
            let colorAttr = geometry.attributes.color;
            let normalAttr = geometry.attributes.normal;
            let texcoordAttr = geometry.attributes.texcoord0;

            mesh.updateWorldTransform();
            var normalMat = mesh.worldTransform.clone().invert().transpose();

            var pos = new Vector3();
            var nor = new Vector3();
            var col = [];
            var uv = [];

            var hasTexcoord = !!(texcoordAttr && texcoordAttr.value);
            var hasNormal = !!(normalAttr && normalAttr.value);
            var hasColor = !!(colorAttr && colorAttr.value);

            var tmp = [];
            for (var i = 0; i < geometry.vertexCount; i++) {
                positionAttr.get(i, pos.array);

                Vector3.transformMat4(pos, pos, mesh.worldTransform);

                // PENDING
                quantizeArr(tmp, pos.array, 1e5);
                var vItem = 'v ' + tmp.join(' ');
                if (hasColor && !opts.storeVertexColorInTexture) {
                    colorAttr.get(i, col);
                    quantizeArr(col, col, 1e3);
                    vItem += ' ' + col.join(' ');
                }
                vStr.push(vItem);

                if (hasNormal) {
                    normalAttr.get(i, nor.array);
                    Vector3.transformMat4(nor, nor, normalMat);
                    Vector3.normalize(nor, nor);
                    quantizeArr(tmp, nor.array, 1e3);
                    vnStr.push('vn ' + tmp.join(' '));
                }
                else {
                    vnStr.push('vn 0 0 0');
                }
                if (hasTexcoord) {
                    texcoordAttr.get(i, uv);
                    quantizeArr(uv, uv, 1e5);
                    vtStr.push('vt ' + uv.join(' '));
                }
                else {
                    vtStr.push('vt 0 0');
                }
            }

            var fStr = [];
            var indices = [];
            for (var i = 0; i < geometry.triangleCount; i++) {
                geometry.getTriangleIndices(i, indices);
                // Start from 1
                for (var k = 0; k < 3; k++) {
                    indices[k] += indexStart;
                    var idx = indices[k];
                    // if (hasTexcoord) {
                        indices[k] += '/' + idx;
                    // }
                    // if (hasNormal) {
                    //     if (!hasTexcoord) {
                    //         indices[k] += '/';
                    //     }
                        indices[k] += '/' + idx;
                    // }
                }

                fStr.push('f ' + indices.join(' '));
            }

            objStr += vStr.join('\n') + '\n'
                + vnStr.join('\n') + '\n'
                + vtStr.join('\n') + '\n'
                + 'usemtl ' + materialName + '\n'
                + fStr.join('\n') + '\n';

            indexStart += geometry.vertexCount;
        }
    });

    var mtlStr = [
        CREDIT
    ];
    for (var matName in materialLib) {
        var material = materialLib[matName];
        mtlStr.push('newmtl ' + matName);
        for (var key in material) {
            var val = material[key];
            mtlStr.push(key + ' ' + val);
        }
    }

    return {
        obj: objStr,
        mtl: mtlStr.join('\n')
    };
};